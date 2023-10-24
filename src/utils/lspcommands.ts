import {
  IList,
  ListAction,
  ListContext,
  ListItem,
  SymbolInformation,
  commands,
  window,
  workspace,
} from "coc.nvim"
import { activeTextDocument } from "../editor"
import { runBin } from "./tools"

export async function goplsTidy() {
  const doc = await workspace.document
  await commands.executeCommand("gopls.tidy", { URIs: [doc.uri] })
}

export async function goplsRunTests() {
  const doc = await activeTextDocument()
  if (!doc.uri.endsWith("_test.go")) {
    window.showMessage("Document is not a test file", "error")
    return
  }

  // const { line } = await window.getCursorPosition()
  // const text = doc.getText({
  //   start: { line, character: 0 },
  //   end: { line, character: Infinity },
  // })

  // const re = /^func\s+((Test|Benchmark)\w+)\s?\(/gm
  // const m = re.exec(text)
  // if (m && m[1]) {
  //   window.showMessage(m[1])
  //   await runGoplsTests(doc.uri, m[1])
  //   return
  // }
  // if no function if found, put all functions to list so that user can choose what to execute
  workspace.nvim.command("CocList gotests", true)
}

export async function goplsListKnownPackages() {
  workspace.nvim.command("CocList goknownpackages", true)
}

async function runGoplsTests(docUri: string, ...funcNames: string[]) {
  const tests: string[] = []
  const bench: string[] = []
  funcNames.forEach((funcName) => {
    if (funcName.startsWith("Test")) {
      tests.push(funcName)
    } else if (funcName.startsWith("Benchmark")) {
      bench.push(funcName)
    }
  })

  if (tests.length === 0 && bench.length === 0) {
    window.showMessage("No tests or benchmarks found in current file")
    return
  }

  window.showMessage("Running " + [...tests, ...bench].join(", "))
  await commands.executeCommand("gopls.run_tests", {
    // The test file containing the tests to run.
    URI: docUri,
    // Specific test names to run, e.g. TestFoo.
    Tests: tests,
    // Specific benchmarks to run, e.g. BenchmarkFoo.
    Benchmarks: bench,
  })
}

type CocDocumentSymbol = {
  kind: string
  text: string
}

type GoTestsData = {
  docUri: string
  container: string
  tests: string[]
}

type GoTestsListItem = { data: GoTestsData } & Omit<ListItem, "data">

export class GoTestsList implements IList {
  public readonly name = "gotests"
  public readonly description = "go tests & benchmarks in current file"
  public readonly defaultAction = "debug test"
  public actions: ListAction[] = []

  constructor() {
    this.actions.push(
      {
        name: "run",
        execute: async (item: GoTestsListItem) => {
          const { docUri, tests } = item.data
          await runGoplsTests(docUri, ...tests)
        },
      },
      {
        name: "yank as go test",
        execute: async (item: GoTestsListItem) => {
          const { tests, container } = item.data
          if (tests.length === 0) {
            return
          }
          const content = goTestCommand(tests, container)
          // console.log(content)
          await workspace.nvim.command(`let @+ = "${content}"`, true)
          window.showMessage("yanked to + register")
        },
      },
      {
        name: "AsyncRun",
        execute: async (item: GoTestsListItem) => {
          const { tests, container } = item.data
          if (tests.length === 0) {
            return
          }
          const content: string = goTestCommand(tests, container)
          // console.log(content)
          await workspace.nvim.command(`AsyncRun ${content}`, true)
        },
      },
      {
        name: "yank test name",
        execute: async (item: GoTestsListItem) => {
          const { tests } = item.data
          const content = tests.join(" ")
          await workspace.nvim.command(`let @+ = "${content}"`, true)
          window.showMessage("yanked to + register")
        },
      },
      {
        name: "debug test",
        execute: async (item: GoTestsListItem) => {
          const { tests, container } = item.data
          const names = `^${tests.join("|")}$`
          await workspace.nvim.command(`lua require('dap').run({ type = "go", name = "${tests.join(" ")}", request = "launch", mode = "test", program = "${container}", args = { "-test.run", "${names}" } })`)
        },
      }
    )
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    const pkg = await currentPackage()
    const pkgSymbols: SymbolInformation[] = await Promise.all([
      await workspace.nvim.call(
        "CocAction",
        ["getWorkspaceSymbols", `^${pkg}.Test`]
      ),
      await workspace.nvim.call(
        "CocAction",
        ["getWorkspaceSymbols", `^${pkg}.Benchmark`]
      ),
    ]).then(([t, b]) => t.concat(b))
    const thisPkgSymbols = pkgSymbols.filter(s => s.kind === 12)
    let tests: string[] = thisPkgSymbols.map(s => s.name.split(".")[1])
    let container: string
    if (thisPkgSymbols.length !== 0) {
      container = thisPkgSymbols[0].containerName
    } else {
      // window.showMessage("doc symbols")
      // we would want to see all tests in the package current files is located
      // however it's not support because of:
      // https://github.com/golang/go/issues/37237
      const symbols: CocDocumentSymbol[] = await workspace.nvim.call(
        "CocAction",
        ["documentSymbols", context.buffer.id]
      )
      // window.showMessage("doc symbols" + symbols.length)
      // window.showMessage(JSON.stringify(symbols.filter(s => s.text.startsWith("Test")), null, 2))
      tests = symbols.filter(
        (s) =>
          s.kind === "Function" &&
          (s.text.startsWith("Test") || s.text.startsWith("Benchmark"))
      ).map(s => s.text)

      // hacky way to retrieve current package qualified name
      const symbol: SymbolInformation[] = await workspace.nvim.call(
        "CocAction",
        ["getWorkspaceSymbols", `'${pkg}.${tests[0]}`]
      )
      if (symbol.length !== 1) {
        window.showMessage("can't retrieve full go package for current file")
        return
      }
      container = symbol[0].containerName
    }
    const doc = workspace.getDocument(context.buffer.id)

    const items = tests.map<GoTestsListItem>((t) => ({
      label: t,
      filterText: t,
      data: { docUri: doc.uri, tests: [t], container },
    }))
    if (tests.length > 1) {
      items.push({
        label: "all",
        filterText: "all",
        // we need to remember the docUri in case the list is resumed. At this point the doc would be a different one
        data: { docUri: doc.uri, tests, container },
      })
    }
    return items
  }

  public dispose() {
    console.debug("clearing gotest list")
  }
}

export class GoKnownPackagesList implements IList {
  public readonly name = "goknownpackages"
  public readonly description = "go known packages"
  public readonly defaultAction = "import"
  public actions: ListAction[] = []

  constructor() {
    this.actions.push(
      {
        name: "import",
        execute: async (item: ListItem) => {
          const doc = await activeTextDocument()
          await commands.executeCommand("gopls.add_import", {
            // The test file containing the tests to run.
            URI: doc.uri,
            ImportPath: item.filterText,
          })
        },
      },
      {
        name: "yank",
        execute: async (item: ListItem) => {
          await workspace.nvim.command(`let @" = "${item.filterText}"`, true)
          window.showMessage('yanked to " register')
        },
      }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
  public async loadItems(_: ListContext): Promise<ListItem[]> {
    const doc = await activeTextDocument()
    const result: {
      Packages: string[]
    } = await commands.executeCommand("gopls.list_known_packages", {
      URI: doc.uri,
    })
    if (!result || !result.Packages || result.Packages.length === 0) {
      // window.showMessage("No known packages found", "error")
      return []
    }
    const items = result.Packages.map<ListItem>((pkg) => ({
      label: pkg,
      filterText: pkg,
    }))
    return items
  }

  public dispose() {
    console.debug("clearing goknownpackages list")
  }
}

function goTestCommand(tests: string[], container: string) {
  let content: string
  if (tests.length === 1) {
    const test: string = tests[0]
    console.log("test", test)
    if (test.startsWith("Benchmark")) {
      content = `go test ${container} -bench '^${test}$' -run XXX -timeout 30s -v -count 1`
    } else {
      content = `go test ${container} -run '^${test}$' -timeout 30s -v -count 1`
    }
  } else {
    content = `go test ${container} -run '^${tests
      .filter(t => t.startsWith("Test"))
      .join("|")}$' -timeout 30s -v -count 1`
  }
  return content
}

export async function setBufferPackageName() {
  const pkg = await currentPackage()
  const bufnr = await workspace.nvim.call('bufnr', ['%'])
  const buffer = workspace.nvim.createBuffer(bufnr)
  buffer.setVar('coc_current_package', pkg, true)
  workspace.nvim.call('coc#util#do_autocmd', ['CocStatusChange'], true)
}

async function currentPackage(): Promise<string> {
  try {
    await activeTextDocument()
  } catch {
    return ""
  }
  // TODO: preferrably use lsp to query, running `go list` is expensive
  const fn = await workspace.nvim.call('expand', '%:p:h') as string
  // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
  const [_, out] = await runBin('go', ['list', '-f', '{{.Name}}'], { cwd: fn })
  // const [_, out] = await runBin('go', ['list', '-f', '{{.ImportPath}}', fn])
  return (out as string).trim()
}
