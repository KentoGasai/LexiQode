/**
 * Report the diagnostics an editor would show for this project.
 *
 * Written because "the editor underlines my file in red" is otherwise a
 * guessing game: the editor's language service can be a different TypeScript
 * build than the one `npm run compile` uses, and it resolves type roots against
 * the project folder rather than the shell's working directory. Both facts
 * matter, and either one can produce errors that the build never sees.
 *
 *     node tools/check-types.js                      # the local TypeScript
 *     node tools/check-types.js --editor               # the editor's bundled one
 *     node tools/check-types.js --compiler <path>      # an explicit build
 *     node tools/check-types.js --no-types             # ignore the "types" option
 *
 * Exit code is 0 when the project is clean, 1 when diagnostics were found, and
 * 2 when the tool itself could not run - so it is safe to use in a script.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { editor: false, compiler: undefined, noTypes: false, project: projectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--editor') {
      options.editor = true;
    } else if (flag === '--no-types') {
      options.noTypes = true;
    } else if (flag === '--compiler') {
      options.compiler = argv[index + 1];
      index += 1;
    } else if (flag === '--project') {
      options.project = path.resolve(argv[index + 1]);
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\s*\/\*\*?/, ''));
      process.exit(0);
    }
  }
  return options;
}

/** Find the TypeScript that each installed editor would hand to the language service. */
function findEditorTypescript() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const edition of ['VSCodium', 'cursor', 'Microsoft VS Code']) {
      candidates.push(
        path.join(local, 'Programs', edition, 'resources', 'app', 'extensions', 'node_modules', 'typescript')
      );
    }
  }
  if (process.platform !== 'win32') {
    candidates.push(
      '/Applications/VSCodium.app/Contents/Resources/app/extensions/node_modules/typescript',
      '/Applications/Cursor.app/Contents/Resources/app/extensions/node_modules/typescript'
    );
  }
  for (const folder of candidates) {
    const entry = path.join(folder, 'lib', 'typescript.js');
    if (fs.existsSync(entry)) {
      const manifest = path.join(folder, 'package.json');
      let version = 'unknown';
      try {
        version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
      } catch {
        // A missing manifest only means the version label is unavailable.
      }
      return { entry, version, folder };
    }
  }
  return undefined;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let compiler = options.compiler;
  let compilerLabel = compiler ? `explicit: ${compiler}` : '';
  if (!compiler && options.editor) {
    const found = findEditorTypescript();
    if (!found) {
      console.error('No editor with a bundled TypeScript was found. Pass --compiler <path to typescript.js>.');
      process.exit(2);
    }
    compiler = found.entry;
    compilerLabel = `editor: ${found.version} (${found.folder})`;
  }
  if (!compiler) {
    compiler = path.join(projectRoot, 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (!fs.existsSync(compiler)) {
      console.error('The local TypeScript is not installed. Run: npm install');
      process.exit(2);
    }
    compilerLabel = `local: ${JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules', 'typescript', 'package.json'), 'utf8')).version}`;
  }

  // A first, human-readable check of the things that most often go wrong.
  const problems = [];
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    problems.push('node_modules is missing here. Run: npm install');
  } else if (!fs.existsSync(path.join(projectRoot, 'node_modules', '@types', 'node', 'index.d.ts'))) {
    problems.push('@types/node is missing here. Run: npm install');
  }
  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'typescript'))) {
    problems.push('typescript is missing here. Run: npm install');
  }

  const ts = require(compiler);
  const configPath = path.join(options.project, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    console.error(`tsconfig.json could not be read: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`);
    process.exit(2);
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, options.project);
  if (options.noTypes) {
    delete parsed.options.types;
  }

  // The language service resolves type roots and relative paths against the
  // project folder, not against wherever this process happens to have started.
  const host = ts.createCompilerHost(parsed.options);
  host.getCurrentDirectory = () => options.project;
  const program = ts.createProgram(parsed.fileNames, parsed.options, host, undefined, parsed.errors);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  console.log(`typescript      ${ts.version}  (${compilerLabel})`);
  console.log(`project         ${options.project}`);
  console.log(`files           ${parsed.fileNames.length}`);
  console.log(`types option    ${options.noTypes ? '(ignored on purpose)' : JSON.stringify(parsed.options.types ?? null)}`);
  console.log('');

  for (const problem of problems) {
    console.log(`SETUP  ${problem}`);
  }

  if (!diagnostics.length) {
    console.log(problems.length ? 'No type errors, but the setup problems above will break the build.' : 'No type errors.');
    process.exit(problems.length ? 1 : 0);
  }

  for (const diagnostic of diagnostics) {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const relative = path.relative(options.project, diagnostic.file.fileName);
      console.log(
        `${relative}:${position.line + 1}:${position.character + 1}  ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      );
    } else {
      console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    }
  }
  console.log('');
  console.log(`${diagnostics.length} diagnostic(s)`);
  process.exit(1);
}

main();