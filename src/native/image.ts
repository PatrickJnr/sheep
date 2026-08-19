/**
 * The `.fleece` image: a Baa program, parsed and checked, in a form a native
 * runtime can load without a parser.
 *
 * Why a serialised tree rather than source or bytecode.
 *
 * Source would mean a second lexer and parser living in the native runtime,
 * and two frontends drift. Every diagnostic, every precedence rule and every
 * newline decision would have to be maintained twice, and the second copy
 * would be the one nobody runs `baa check` through. An image keeps exactly one
 * frontend: the reference implementation in `src/`, which the whole test suite
 * already covers.
 *
 * Bytecode would mean a compiler as well, and a compiler is the part most
 * likely to disagree with the tree-walker about a corner of the semantics.
 * That is worth doing when a measurement asks for it (see ARCHITECTURE.md); it
 * is not the thing to build before anything runs at all.
 *
 * The format is versioned and the runtime refuses an image it was not built
 * for, because a silently misread tree is a wrong answer rather than an error.
 */

import type {
  Binding,
  Block,
  Expression,
  MatchArm,
  Param,
  Pattern,
  Statement,
} from "../ast/ast.ts";
import type { Span } from "../diagnostics/source.ts";

export const MAGIC = "FLEECE\n";
export const IMAGE_VERSION = 1;

/** A module in the bundle, already parsed and checked. */
export type ImageModule = {
  /** Import name, for diagnostics: the file's stem. */
  readonly name: string;
  /** Path as written into the image, relative to the project root. */
  readonly path: string;
  /** Original text, so a runtime error can underline the line it happened on. */
  readonly source: string;
  readonly body: readonly Statement[];
};

export type Image = {
  readonly modules: readonly ImageModule[];
  /** Index into `modules` of the program that runs first. */
  readonly entry: number;
  /** Application metadata, from `[app]` in `baa.toml`. */
  readonly app: Readonly<Record<string, string>>;
  /** Resolves a relative import to an index in `modules`. */
  readonly resolveImport: (fromModule: number, source: string) => number;
  /** True when this import was bundled: a relative path, or a dependency. */
  readonly hasImport: (fromModule: number, source: string) => boolean;
};

// Statement tags. The numbers are part of the format: append, never renumber.
const S_LET = 1;
const S_FN = 2;
const S_EXPR = 3;
const S_BAA = 4;
const S_RETURN = 5;
const S_IF = 6;
const S_WHILE = 7;
const S_FOR = 8;
const S_BREAK = 9;
const S_CONTINUE = 10;
const S_IMPORT = 11;
const S_THROW = 12;
const S_TRY = 13;
const S_TEST = 14;

const E_NUMBER = 1;
const E_STRING = 2;
const E_BOOL = 3;
const E_NIL = 4;
const E_IDENT = 5;
const E_ARRAY = 6;
const E_MAP = 7;
const E_FN = 8;
const E_UNARY = 9;
const E_BINARY = 10;
const E_LOGICAL = 11;
const E_ASSIGN = 12;
const E_CALL = 13;
const E_MEMBER = 14;
const E_INDEX = 15;
const E_RANGE = 16;
const E_MATCH = 17;

const B_NAME = 1;
const B_ARRAY = 2;
const B_MAP = 3;

const P_WILDCARD = 1;
const P_BINDING = 2;
const P_LITERAL = 3;

/**
 * Operators travel as small integers rather than strings, so the runtime
 * matches on a number instead of comparing text on every arithmetic operation.
 */
const BINARY_OPS = ["+", "-", "*", "/", "%", "**", "==", "!=", "<", "<=", ">", ">=", "in"] as const;
const LOGICAL_OPS = ["&&", "||", "??"] as const;
const ASSIGN_OPS = ["=", "+=", "-=", "*=", "/=", "%="] as const;
const UNARY_OPS = ["-", "!"] as const;

class Writer {
  readonly bytes: number[] = [];
  readonly #strings = new Map<string, number>();
  readonly stringList: string[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u32(value: number): void {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  f64(value: number): void {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, true);
    for (const byte of new Uint8Array(buffer)) this.bytes.push(byte);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  /** Strings are interned: a program repeats identifiers more than anything else. */
  str(text: string): void {
    let index = this.#strings.get(text);
    if (index === undefined) {
      index = this.stringList.length;
      this.#strings.set(text, index);
      this.stringList.push(text);
    }
    this.u32(index);
  }

  span(span: Span): void {
    this.u32(span.start);
    this.u32(span.end);
  }

  list<T>(items: readonly T[], write: (item: T) => void): void {
    this.u32(items.length);
    for (const item of items) write(item);
  }
}

export function encodeImage(image: Image): Uint8Array {
  const w = new Writer();
  let currentModule = 0;

  const writeBlock = (block: Block): void => {
    w.list(block.body, writeStatement);
  };

  const writeParams = (params: readonly Param[]): void => {
    w.list(params, (param) => {
      w.str(param.name);
      w.bool(param.rest);
      if (param.defaultValue === null) {
        w.u8(0);
      } else {
        w.u8(1);
        writeExpression(param.defaultValue);
      }
    });
  };

  const writeBinding = (binding: Binding): void => {
    w.span(binding.span);
    switch (binding.kind) {
      case "NameBinding":
        w.u8(B_NAME);
        w.str(binding.name);
        return;
      case "ArrayBinding":
        w.u8(B_ARRAY);
        w.list(binding.elements, (element) => {
          w.bool(element.rest);
          writeBinding(element.binding);
        });
        return;
      case "MapBinding":
        w.u8(B_MAP);
        w.list(binding.entries, (entry) => {
          w.str(entry.key);
          writeBinding(entry.binding);
        });
        return;
    }
  };

  const writePattern = (pattern: Pattern): void => {
    w.span(pattern.span);
    switch (pattern.kind) {
      case "WildcardPattern":
        w.u8(P_WILDCARD);
        return;
      case "BindingPattern":
        w.u8(P_BINDING);
        w.str(pattern.name);
        return;
      case "LiteralPattern":
        w.u8(P_LITERAL);
        writeExpression(pattern.value);
        return;
    }
  };

  const writeArm = (arm: MatchArm): void => {
    w.span(arm.span);
    w.list(arm.patterns, writePattern);
    if (arm.guard === null) {
      w.u8(0);
    } else {
      w.u8(1);
      writeExpression(arm.guard);
    }
    writeExpression(arm.body);
  };

  function writeExpression(expression: Expression): void {
    w.span(expression.span);
    switch (expression.kind) {
      case "IntLiteral":
      case "FloatLiteral":
        w.u8(E_NUMBER);
        w.f64(expression.value);
        return;
      case "StringLiteral":
        w.u8(E_STRING);
        w.list(expression.segments, (segment) => {
          if (segment.kind === "text") {
            w.u8(0);
            w.str(segment.value);
          } else {
            w.u8(1);
            writeExpression(segment.expression);
          }
        });
        return;
      case "BoolLiteral":
        w.u8(E_BOOL);
        w.bool(expression.value);
        return;
      case "NilLiteral":
        w.u8(E_NIL);
        return;
      case "Identifier":
        w.u8(E_IDENT);
        w.str(expression.name);
        return;
      case "ArrayLiteral":
        w.u8(E_ARRAY);
        w.list(expression.elements, writeExpression);
        return;
      case "MapLiteral":
        w.u8(E_MAP);
        w.list(expression.entries, (entry) => {
          writeExpression(entry.key);
          writeExpression(entry.value);
        });
        return;
      case "FunctionExpression":
        w.u8(E_FN);
        w.str(expression.name ?? "anonymous");
        writeParams(expression.params);
        writeBlock(expression.body);
        return;
      case "UnaryExpression":
        w.u8(E_UNARY);
        w.u8(UNARY_OPS.indexOf(expression.operator));
        writeExpression(expression.operand);
        return;
      case "BinaryExpression":
        w.u8(E_BINARY);
        w.u8(BINARY_OPS.indexOf(expression.operator));
        w.span(expression.operatorSpan);
        writeExpression(expression.left);
        writeExpression(expression.right);
        return;
      case "LogicalExpression":
        w.u8(E_LOGICAL);
        w.u8(LOGICAL_OPS.indexOf(expression.operator));
        writeExpression(expression.left);
        writeExpression(expression.right);
        return;
      case "AssignmentExpression":
        w.u8(E_ASSIGN);
        w.u8(ASSIGN_OPS.indexOf(expression.operator));
        writeExpression(expression.target);
        writeExpression(expression.value);
        return;
      case "CallExpression":
        w.u8(E_CALL);
        w.span(expression.argsSpan);
        writeExpression(expression.callee);
        w.list(expression.args, writeExpression);
        return;
      case "MemberExpression":
        w.u8(E_MEMBER);
        w.str(expression.property);
        w.span(expression.propertySpan);
        writeExpression(expression.object);
        return;
      case "IndexExpression":
        w.u8(E_INDEX);
        writeExpression(expression.object);
        writeExpression(expression.index);
        return;
      case "RangeExpression":
        w.u8(E_RANGE);
        w.bool(expression.inclusive);
        writeExpression(expression.start);
        writeExpression(expression.end);
        return;
      case "MatchExpression":
        w.u8(E_MATCH);
        writeExpression(expression.subject);
        w.list(expression.arms, writeArm);
        return;
    }
  }

  function writeStatement(statement: Statement): void {
    w.span(statement.span);
    switch (statement.kind) {
      case "LetStatement":
        w.u8(S_LET);
        w.bool(statement.mutable);
        w.bool(statement.exported);
        writeBinding(statement.binding);
        writeExpression(statement.value);
        return;
      case "FunctionDeclaration":
        w.u8(S_FN);
        w.str(statement.name);
        w.bool(statement.exported);
        writeParams(statement.params);
        writeBlock(statement.body);
        return;
      case "ExpressionStatement":
        w.u8(S_EXPR);
        writeExpression(statement.expression);
        return;
      case "BaaStatement":
        w.u8(S_BAA);
        w.list(statement.values, writeExpression);
        return;
      case "ReturnStatement":
        w.u8(S_RETURN);
        if (statement.value === null) {
          w.u8(0);
        } else {
          w.u8(1);
          writeExpression(statement.value);
        }
        return;
      case "IfStatement":
        w.u8(S_IF);
        writeExpression(statement.condition);
        writeBlock(statement.consequent);
        if (statement.alternate === null) {
          w.u8(0);
        } else if (statement.alternate.kind === "Block") {
          w.u8(1);
          writeBlock(statement.alternate);
        } else {
          // `else if` stays a statement rather than being flattened into a
          // block, so the runtime reports the span the source actually has.
          w.u8(2);
          writeStatement(statement.alternate);
        }
        return;
      case "WhileStatement":
        w.u8(S_WHILE);
        writeExpression(statement.condition);
        writeBlock(statement.body);
        return;
      case "ForStatement":
        w.u8(S_FOR);
        w.str(statement.name);
        if (statement.valueName === null) {
          w.u8(0);
        } else {
          w.u8(1);
          w.str(statement.valueName);
        }
        writeExpression(statement.iterable);
        writeBlock(statement.body);
        return;
      case "BreakStatement":
        w.u8(S_BREAK);
        return;
      case "ContinueStatement":
        w.u8(S_CONTINUE);
        return;
      case "ImportDeclaration": {
        w.u8(S_IMPORT);
        // Resolved here, not at runtime: the native runtime never consults the
        // filesystem to find a module, so a shipped application cannot be
        // redirected by a file dropped next to it.
        // A `[wool]` dependency is bundled like any other module, so it is
        // written as an index too: `import my_lib` and `import "./lib.baa"`
        // differ only in how they were spelled.
        const bundled = statement.relative ? true : image.hasImport(currentModule, statement.source);
        if (bundled) {
          w.u8(1);
          w.u32(image.resolveImport(currentModule, statement.source));
        } else {
          w.u8(0);
          w.str(statement.source);
        }
        w.str(statement.alias);
        w.span(statement.sourceSpan);
        w.list(statement.named, (specifier) => {
          w.str(specifier.name);
          w.str(specifier.alias);
          w.span(specifier.span);
        });
        return;
      }
      case "ThrowStatement":
        w.u8(S_THROW);
        writeExpression(statement.value);
        return;
      case "TryStatement":
        w.u8(S_TRY);
        writeBlock(statement.block);
        if (statement.handler === null) {
          w.u8(0);
        } else {
          w.u8(1);
          if (statement.catchName === null) {
            w.u8(0);
          } else {
            w.u8(1);
            w.str(statement.catchName);
          }
          writeBlock(statement.handler);
        }
        if (statement.finalizer === null) {
          w.u8(0);
        } else {
          w.u8(1);
          writeBlock(statement.finalizer);
        }
        return;
      case "TestDeclaration":
        w.u8(S_TEST);
        w.str(statement.name);
        writeBlock(statement.body);
        return;
    }
  }

  const appKeys = Object.keys(image.app).sort();
  w.list(appKeys, (key) => {
    w.str(key);
    w.str(image.app[key]!);
  });

  w.u32(image.entry);
  w.list(image.modules, (module, ...rest) => {
    void rest;
    currentModule = image.modules.indexOf(module);
    w.str(module.name);
    w.str(module.path);
    w.str(module.source);
    w.list(module.body, writeStatement);
  });

  // The string table is only complete once the body has been written, so it is
  // prepended here rather than reserved and patched.
  const head: number[] = [...new TextEncoder().encode(MAGIC), IMAGE_VERSION];
  const encoder = new TextEncoder();
  const table: number[] = [];
  const count = w.stringList.length;
  table.push(count & 0xff, (count >>> 8) & 0xff, (count >>> 16) & 0xff, (count >>> 24) & 0xff);
  for (const text of w.stringList) {
    const encoded = encoder.encode(text);
    const length = encoded.length;
    table.push(length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff);
    for (const byte of encoded) table.push(byte);
  }
  return new Uint8Array([...head, ...table, ...w.bytes]);
}
