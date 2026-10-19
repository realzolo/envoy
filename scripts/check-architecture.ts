import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root = process.cwd();
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (configFile.error)
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const files = config.fileNames.filter(file => file.startsWith(path.join(root, 'src') + path.sep) && /\.tsx?$/.test(file));
const sources = new Map(files.map(file => [file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)]));
type Edge = {
    target: string;
    specifier: string;
    typeOnly: boolean;
    line: number;
    names: string[];
};
const graph = new Map<string, Edge[]>();
const violations: string[] = [];
const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
const owner = (file: string) => /^src\/modules\/([^/]+)\//.exec(relative(file))?.[1] ?? /^src\/bootstrap\/([^/.]+)\.ts$/.exec(relative(file))?.[1];
const moduleFile = (file: string) => relative(file).startsWith('src/modules/');
const add = (file: string, line: number, message: string) => violations.push(`${relative(file)}:${line}: ${message}`);
const sqlStatement = /^\s*(?:SELECT\s+[\s\S]+?\bFROM\b|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA|FUNCTION|TRIGGER)\s)/i;
for (const [file, source] of sources) {
    const edges: Edge[] = [];
    const restricted = /^src\/(?:modules|platform)\/(?:[^/]+\/)?(?:application|domain)\//.test(relative(file));
    const http = relative(file).startsWith('src/app/api/');
    function inspect(node: ts.Node) {
        let specifier: string | undefined;
        let typeOnly = false;
        let names: string[] = [];
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            specifier = node.moduleSpecifier.text;
            const clause = node.importClause;
            typeOnly = Boolean(clause?.isTypeOnly) || (Boolean(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0) && !clause?.name && Boolean(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly)));
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
                names = clause.namedBindings.elements.map(element => element.propertyName?.text ?? element.name.text);
        }
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifier = node.moduleSpecifier.text;
            typeOnly = node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly));
            if (node.exportClause && ts.isNamedExports(node.exportClause))
                names = node.exportClause.elements.map(element => element.propertyName?.text ?? element.name.text);
        }
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
            specifier = node.arguments[0].text;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (specifier) {
            const resolved = ts.resolveModuleName(specifier, file, config.options, ts.sys).resolvedModule?.resolvedFileName;
            const target = resolved && path.resolve(resolved);
            const databaseImport = /^(?:pg|drizzle-orm)(?:\/|$)/.test(specifier) || Boolean(target && (relative(target).startsWith('src/platform/database/') || relative(target).includes('/infrastructure/')));
            edges.push({ specifier, target: target ?? specifier, typeOnly, line, names });
            if (restricted && databaseImport)
                add(file, line, 'Application/domain must depend on repository ports; database drivers, schema and infrastructure imports are forbidden.');
            if (http && databaseImport)
                add(file, line, 'HTTP controllers must call public application capabilities, never database infrastructure.');
            if (target && owner(target) && owner(file) !== owner(target) && moduleFile(target)) {
                const destination = relative(target);
                const boundary = /^src\/modules\/[^/]+\/(?:public|contracts)\.ts$/.test(destination) || /^src\/modules\/[^/]+\/policy\.ts$/.test(destination);
                const pureType = typeOnly && /^src\/modules\/[^/]+\/domain\//.test(destination);
                const sqlPredicate = relative(file).includes('/infrastructure/') && destination === 'src/modules/identity/infrastructure/authorization.ts' && names.length > 0 && names.every(name => ['domainPermission', 'effectiveDomainGrants', 'outboundDomainAccess', 'inboundDomainAccess'].includes(name));
                if (!boundary && !pureType && !sqlPredicate)
                    add(file, line, `Cross-module import bypasses public.ts/contracts.ts: ${specifier}`);
            }
        }
        if ((restricted || http) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
            const text = ts.isTemplateExpression(node) ? node.head.text : node.text;
            if (sqlStatement.test(text))
                add(file, line, 'SQL belongs in an infrastructure Repository/ReadRepository.');
        }
        ts.forEachChild(node, inspect);
    }
    inspect(source);
    graph.set(file, edges);
}
// Detect actual runtime cycles, including composition roots. Explicit type-only edges are erased.
let nextIndex = 0;
const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
function visit(file: string) {
    indices.set(file, nextIndex);
    low.set(file, nextIndex++);
    stack.push(file);
    onStack.add(file);
    for (const edge of graph.get(file) ?? []) {
        if (edge.typeOnly || !graph.has(edge.target))
            continue;
        if (!indices.has(edge.target)) {
            visit(edge.target);
            low.set(file, Math.min(low.get(file)!, low.get(edge.target)!));
        }
        else if (onStack.has(edge.target))
            low.set(file, Math.min(low.get(file)!, indices.get(edge.target)!));
    }
    if (low.get(file) === indices.get(file)) {
        const component: string[] = [];
        let member: string;
        do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
        } while (member !== file);
        if (component.length > 1)
            add(file, 1, `Runtime import cycle: ${component.map(relative).sort().join(' <-> ')}`);
    }
}
for (const file of graph.keys())
    if (!indices.has(file))
        visit(file);
function checkReachability(start: string, kind: 'worker' | 'client' | 'policy') {
    const visited = new Set<string>();
    const pending = [{ file: start, chain: [relative(start)] }];
    while (pending.length) {
        const current = pending.pop()!;
        if (visited.has(current.file))
            continue;
        visited.add(current.file);
        for (const edge of graph.get(current.file) ?? []) {
            if (edge.typeOnly)
                continue;
            const next = [...current.chain, relative(edge.target)];
            const forbidden = kind === 'policy' ? (edge.specifier === 'server-only' || /^(?:next|pg|drizzle-orm)(?:\/|$)/.test(edge.specifier) || /^(?:node:)?(?:fs|http|https|net|tls|child_process)(?:\/|$)/.test(edge.specifier) || Boolean(graph.has(edge.target) && !/^src\/(?:modules\/[^/]+\/(?:domain\/|contracts\.ts$|policy\.ts$)|integrations\/providers\/contracts\.ts$|lib\/)/.test(relative(edge.target)))) : kind === 'worker' ? (edge.specifier === 'server-only' || /^next(?:\/|$)/.test(edge.specifier)) : (edge.specifier === 'server-only' || /^(?:pg|drizzle-orm)(?:\/|$)/.test(edge.specifier) || relative(edge.target).startsWith('src/platform/') || relative(edge.target).startsWith('src/server/') || /^src\/modules\/[^/]+\/(?:public|application|infrastructure)/.test(relative(edge.target)));
            if (forbidden) {
                add(start, 1, `${kind === 'policy' ? 'Public policy facet must remain pure' : kind === 'worker' ? 'Worker must be framework independent' : 'Client code must not reach server capabilities'}: ${next.join(' -> ')}`);
                continue;
            }
            if (graph.has(edge.target))
                pending.push({ file: edge.target, chain: next });
        }
    }
}
for (const [file, source] of sources) {
    if (/^src\/modules\/[^/]+\/policy\.ts$/.test(relative(file)))
        checkReachability(file, 'policy');
    if (relative(file).startsWith('src/worker/'))
        checkReachability(file, 'worker');
    if (source.statements.some(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client'))
        checkReachability(file, 'client');
}
// Pre-release V1 is a complete empty-database snapshot, never a patch chain.
const migrations = fs.readdirSync(path.join(root, 'db/migrations')).filter(file => file.endsWith('.sql'));
if (migrations.length !== 1 || migrations[0] !== '001_initial.sql')
    violations.push('db/migrations: exactly one application migration, 001_initial.sql, is required before V1 release.');
if (violations.length) {
    console.error([...new Set(violations)].sort().join('\n'));
    console.error(`\nArchitecture check failed (${new Set(violations).size} violations).`);
    process.exitCode = 1;
}
else
    console.log(`Architecture verified: ${files.length} source files; dependency boundaries, runtime cycles, client/worker isolation and one V1 schema.`);
