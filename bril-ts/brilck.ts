#!/usr/bin/env node
import { BaseType } from 'typescript';
import * as bril from './bril';
import {Signature, PolySignature, FuncType, OP_SIGS, TVar, BaseSignature, PolyType} from './types';
import {readStdin, unreachable} from './util';

/**
 * The JavaScript types of Bril constant values.
 */
const CONST_TYPES: {[key: string]: string} = {
  'int': 'number',
  'float': 'number',
  'bool': 'boolean',
};

type VarEnv = Map<bril.Ident, bril.Type>;
type FuncEnv = Map<bril.Ident, FuncType>;
type TypeEnv = Map<TVar, bril.Type | null>;

/**
 * A typing environment that we can use to check instructions within
 * a single function.
 */
interface Env {
  /**
   * The types of all variables defined in the function.
   */
  vars: VarEnv;

  /**
   * The names of all the labels in the function.
   */
  labels: Set<bril.Ident>;

  /**
   * The defined functions in the program.
   */
  funcs: FuncEnv;

  /**
   * The return type of the current function.
   */
  ret: bril.Type | undefined;
}

/**
 * Set the type of variable `id` to `type` in `env`, checking for conflicts
 * with the old type for the variable.
 */
function addType(env: VarEnv, id: bril.Ident, type: bril.Type) {
  let oldType = env.get(id);
  if (oldType) {
    if (!typeEq(oldType, type)) {
      console.error(
        `new type ${type} for ${id} conflicts with old type ${oldType}`
      );
    }
  } else {
    env.set(id, type);
  }
}

/**
 * Look up type variables in TypeEnv, leaving non-variable types unchanged.
 */
function typeLookup(type: PolyType, tenv: TypeEnv | undefined): PolyType {
  if (!tenv) {
    return type;
  }
  if (typeof type !== "string") {
    return type;
  }
  let res = tenv.get(type);
  if (res) {
    return res;
  } else {
    return type;
  }
}

/**
 * Check for type equality.
 *
 * If a type environemnt is supplied, attempt to unify any unset type
 * variables occuring in `b` to make the types match.
 */
function typeEq(a: bril.Type, b: PolyType, tenv?: TypeEnv): boolean {
  // Shall we bind a type variable in b?
  b = typeLookup(b, tenv);
  if (typeof b === "string" && tenv?.has(b)) {
    tenv.set(b, a);
    return true;
  }

  // Normal type comparison.
  if (typeof a === "string" && typeof b === "string") {
    return a == b;
  } else if (typeof a === "object" && typeof b === "object") {
    return typeEq(a.ptr, b.ptr);
  } else {
    return false;
  }
}

/**
 * Format a type as a human-readable string.
 */
function typeFmt(t: PolyType): string {
  if (typeof t === "string") {
    return t;
  } else if (typeof t === "object") {
    return `ptr<${typeFmt(t.ptr)}>`;
  }
  unreachable(t);
}

/**
 * Check an instruction's arguments and labels against a type signature.
 *
 * `sig` may be either a concrete signature or a polymorphic one, in which case
 * we try unify the quantified type. `name` optionally gives a name for the
 * operation to use in error messages; otherwise, we use `instr`'s opcode.
 */
function checkSig(env: Env, instr: bril.Operation, psig: Signature | PolySignature, name?: string) {
  name = name ?? instr.op;

  // Are we handling a polymorphic signature?
  let sig: BaseSignature<PolyType>;
  let tenv: TypeEnv = new Map();
  if ('tvar' in psig) {
    sig = psig.sig;
    tenv.set(psig.tvar, null);
  } else {
    sig = psig;
  }

  // Check destination type.
  if ('type' in instr) {
    if (sig.dest) {
      if (!typeEq(instr.type, sig.dest, tenv)) {
        console.error(
          `result type of ${name} should be ${typeFmt(typeLookup(sig.dest, tenv))}, ` +
          `but found ${typeFmt(instr.type)}`
        );
      }
    } else {
      console.error(`${name} should have no result type`);
    }
  } else {
    if (sig.dest) {
      console.error(
        `missing result type ${typeFmt(typeLookup(sig.dest, tenv))} for ${name}`
      );
    }
  }

  // Check arguments.
  let args = instr.args ?? [];
  if (args.length !== sig.args.length) {
    console.error(
      `${name} expects ${sig.args.length} args, not ${args.length}`
    );
  } else {
    for (let i = 0; i < args.length; ++i) {
      let argType = env.vars.get(args[i]);
      if (!argType) {
        console.error(`${args[i]} (arg ${i}) undefined`);
        continue;
      }
      if (!typeEq(argType, sig.args[i], tenv)) {
        console.error(
          `${args[i]} has type ${typeFmt(argType)}, but arg ${i} for ${name} ` +
          `should have type ${typeFmt(typeLookup(sig.args[i], tenv))}`
        );
      }
    }
  }

  // Check labels.
  let labs = instr.labels ?? [];
  let labCount = sig.labels ?? 0;
  if (labs.length !== labCount) {
    console.error(`${instr.op} needs ${labCount} labels; found ${labs.length}`);
  } else {
    for (let lab of labs) {
      if (!env.labels.has(lab)) {
        console.error(`label .${lab} undefined`);
      }
    }
  }
}

type CheckFunc = (env: Env, instr: bril.Operation) => void;

/**
 * Special-case logic for checking some special functions.
 */
const INSTR_CHECKS: {[key: string]: CheckFunc} = {
  print: (env, instr) => {
    if ('type' in instr) {
      console.error(`print should have no result type`);
    }
  },

  call: (env, instr) => {
    let funcs = instr.funcs ?? [];
    if (funcs.length !== 1) {
      console.error(`call should have one function, not ${funcs.length}`);
      return;
    }

    let funcType = env.funcs.get(funcs[0]);
    if (!funcType) {
      console.error(`function @${funcs[0]} undefined`);
      return;
    }

    checkSig(env, instr, {
      args: funcType.args,
      dest: funcType.ret,
    }, `@${funcs[0]}`);
    return;
  },

  ret: (env, instr) => {
    let args = instr.args ?? [];
    if (env.ret) {
      if (args.length === 0) {
        console.error(`missing return value in function with return type`);
      } else if (args.length !== 1) {
        console.error(`cannot return multiple values`);
      } else {
        checkSig(env, instr, {args: [env.ret]});
      }
    } else {
      if (args.length !== 0) {
        console.error(`returning value in function without a return type`);
      }
    }
    return;
  },
};

function checkOp(env: Env, instr: bril.Operation) {
  let args = instr.args ?? [];

  // Check for special cases.
  let check_func = INSTR_CHECKS[instr.op];
  if (check_func) {
    check_func(env, instr);
    return;
  }

  // General case: use the operation's signature.
  let sig = OP_SIGS[instr.op];
  if (!sig) {
    console.error(`unknown opcode ${instr.op}`);
    return;
  }
  checkSig(env, instr, sig);
}

function checkConst(instr: bril.Constant) {
  if (!('type' in instr)) {
    console.error(`const missing type`);
    return;
  }
  if (typeof instr.type !== 'string') {
    console.error(`const of non-primitive type ${typeFmt(instr.type)}`);
    return;
  }

  let valType = CONST_TYPES[instr.type];
  if (!valType) {
    console.error(`unknown const type ${typeFmt(instr.type)}`);
    return;
  }

  if (typeof instr.value !== valType) {
    console.error(
      `const value ${instr.value} does not match type ${typeFmt(instr.type)}`
    );
  }
}

function checkFunc(funcs: FuncEnv, func: bril.Function) {
  let vars: VarEnv = new Map();
  let labels = new Set<bril.Ident>();

  // Initilize the type environment with the arguments.
  if (func.args) {
    for (let arg of func.args) {
      addType(vars, arg.name, arg.type);
    }
  }

  // Gather up all the types of the local variables and all the label names.
  for (let instr of func.instrs) {
    if ('dest' in instr) {
      addType(vars, instr.dest, instr.type);
    } else if ('label' in instr) {
      if (labels.has(instr.label)) {
        console.error(`multiply defined label .${instr.label}`);
      } else {
        labels.add(instr.label);
      }
    }
  }

  // Check each instruction.
  for (let instr of func.instrs) {
    if ('op' in instr) {
      if (instr.op === 'const') {
        checkConst(instr);
      } else {
        checkOp({vars, labels, funcs, ret: func.type}, instr);
      }
    }
  }
}

function checkProg(prog: bril.Program) {
  // Gather up function types.
  let funcEnv: FuncEnv = new Map();
  for (let func of prog.functions) {
    funcEnv.set(func.name, {
      ret: func.type,
      args: func.args?.map(a => a.type) ?? [],
    });
  }

  // Check each function.
  for (let func of prog.functions) {
    checkFunc(funcEnv, func);
  }
}

async function main() {
  let prog = JSON.parse(await readStdin()) as bril.Program;
  checkProg(prog);
}

main();
