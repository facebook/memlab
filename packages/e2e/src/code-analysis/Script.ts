/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {Nullable, Optional} from '@memlab/core';

import type {
  ArrowFunctionExpression,
  ClassMethod,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  ObjectMethod,
  Program,
  SourceLocation,
} from '@babel/types';
import type {NodePath} from '@babel/traverse';
import type {ParseResult} from '@babel/core';

import traverse from '@babel/traverse';
import {parse} from '@babel/parser';
import {utils} from '@memlab/core';

export type ClosureScope = {
  functionName: Optional<string>;
  functionType: string;
  variablesDefined: string[];
  usedVariablesFromParentScope: string[];
  nestedClosures: ClosureScope[];
  loc: Optional<SourceLocation>;
};

type FunctionClass =
  | FunctionDeclaration
  | FunctionExpression
  | ObjectMethod
  | ClassMethod
  | ArrowFunctionExpression;

function isFunctionType(type: string): boolean {
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ObjectMethod' ||
    type === 'ClassMethod' ||
    type === 'ArrowFunctionExpression'
  );
}

export default class Script {
  private code: string;
  private ast: Nullable<ParseResult>;
  private closureScopeTree: ClosureScope;

  constructor(code: string) {
    this.code = code;
    this.ast = parse(code, {
      sourceType: 'script',
    });
    this.closureScopeTree = this.buildClosureScopeTree(this.ast);
  }

  public getClosureScopeTree(): ClosureScope {
    return this.closureScopeTree;
  }

  private locToStr(loc: Optional<SourceLocation>): string {
    if (loc == null) {
      throw utils.haltOrThrow(`location in ast is ${loc}`);
    }
    return JSON.stringify(loc);
  }

  private findParentFunctionPath(
    path: NodePath<FunctionClass | Identifier>,
  ): Nullable<NodePath<FunctionClass | Program>> {
    let curPath = path.parentPath;
    while (curPath) {
      if (
        isFunctionType(curPath.node.type) ||
        curPath.node.type === 'Program'
      ) {
        return curPath as NodePath<FunctionClass | Program>;
      }
      if (curPath.parentPath == null) {
        break;
      }
      curPath = curPath.parentPath;
    }
    return null;
  }

  private findParentFunctionClosureScope(
    locToClosureScopeMap: Map<string, ClosureScope>,
    path: NodePath<FunctionClass | Identifier>,
  ): ClosureScope {
    const parentPath = this.findParentFunctionPath(path);
    if (!parentPath) {
      throw utils.haltOrThrow('cannot find parent scope');
    }
    const parentClosureScope = locToClosureScopeMap.get(
      this.locToStr(parentPath.node.loc),
    );
    if (!parentClosureScope) {
      throw utils.haltOrThrow('cannot find parent scope');
    }
    return parentClosureScope;
  }

  private findGrandparentFunctionClosureScope(
    locToClosureScopeMap: Map<string, ClosureScope>,
    path: NodePath<FunctionClass | Identifier>,
  ): Nullable<ClosureScope> {
    const parentPath = this.findParentFunctionPath(path);
    if (!parentPath) {
      throw utils.haltOrThrow('cannot find parent scope');
    }
    const grandparentPath = this.findParentFunctionPath(
      parentPath as NodePath<FunctionClass>,
    );
    if (!grandparentPath) {
      return null;
    }
    const grandparentClosureScope = locToClosureScopeMap.get(
      this.locToStr(grandparentPath.node.loc),
    );
    if (!grandparentClosureScope) {
      throw utils.haltOrThrow('cannot find parent scope');
    }
    return grandparentClosureScope;
  }

  private buildClosureScopeTree(ast: ParseResult): ClosureScope {
    const root = {
      functionName: null,
      functionType: ast.program.type,
      variablesDefined: [] as string[],
      usedVariablesFromParentScope: [] as string[],
      nestedClosures: [] as ClosureScope[],
      loc: ast.program.loc,
    };

    const locToClosureScopeMap = new Map<string, ClosureScope>();
    locToClosureScopeMap.set(this.locToStr(ast.program.loc), root);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // build closure scope hierarchy
    const buildClosureScopeFromFunction = function (
      path: NodePath<FunctionClass>,
    ) {
      const closureScope = {
        functionName: 'id' in path.node ? path.node?.id?.name : null,
        functionType: path.node.type,
        variablesDefined: Object.keys(path.scope.bindings),
        usedVariablesFromParentScope: [] as string[],
        nestedClosures: [] as ClosureScope[],
        loc: path.node.loc,
      };
      locToClosureScopeMap.set(self.locToStr(path.node.loc), closureScope);
      // find and connect to parent closure scope
      const parentClosureScope = self.findParentFunctionClosureScope(
        locToClosureScopeMap,
        path,
      );
      parentClosureScope.nestedClosures.push(closureScope);
    };

    // Traverse the parent scope of the containing scope
    // to find out if both of the conditions are true:
    // 1. This is a var use in the containing scope
    // 2. This is a var defined in the direct parent scope
    //    of the containing scope
    // If true, add the identifer name to the usedVariablesFromParentScope
    // of the containing scope
    const fillInVarInfo = function (path: NodePath<Identifier>) {
      // if the identifier is a function name of a function definition
      if (isFunctionType(path.parentPath.node.type)) {
        return;
      }
      const name = path.node.name;
      let parentPath = self.findParentFunctionPath(path);
      let parentClosureScope = parentPath
        ? locToClosureScopeMap.get(self.locToStr(parentPath.node.loc))
        : null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!parentPath || !parentClosureScope) {
          break;
        }
        const grandparentPath = self.findParentFunctionPath(
          parentPath as NodePath<FunctionClass>,
        );
        if (!grandparentPath) {
          break;
        }
        const grandparentClosureScope = locToClosureScopeMap.get(
          self.locToStr(grandparentPath.node.loc),
        );
        if (!grandparentClosureScope) {
          break;
        }
        if (
          grandparentClosureScope.variablesDefined.includes(name) &&
          !parentClosureScope.usedVariablesFromParentScope.includes(name)
        ) {
          parentClosureScope.usedVariablesFromParentScope.push(name);
          break;
        }
        parentPath = grandparentPath;
        parentClosureScope = grandparentClosureScope;
      }
    };
    traverse(ast, {
      FunctionDeclaration: buildClosureScopeFromFunction,
      FunctionExpression: buildClosureScopeFromFunction,
      ObjectMethod: buildClosureScopeFromFunction,
      ClassMethod: buildClosureScopeFromFunction,
      ArrowFunctionExpression: buildClosureScopeFromFunction,
      Identifier: fillInVarInfo,
      Program: (path: NodePath<Program>) => {
        root.variablesDefined = Object.keys(path.scope.bindings);
      },
    });
    return root;
  }
}
