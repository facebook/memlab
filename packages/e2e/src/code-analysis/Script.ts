/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {Nullable, Optional} from '@memlab/core';

import type {
  ArrowFunctionExpression,
  ClassMethod,
  File,
  FunctionDeclaration,
  FunctionExpression,
  ObjectMethod,
  Program,
  SourceLocation,
} from '@babel/types';
import type {NodePath} from '@babel/traverse';
import type {ParseResult} from '@babel/parser';

import traverse from '@babel/traverse';
import {parse} from '@babel/parser';
import {utils} from '@memlab/core';

export type ClosureScope = {
  functionName: Optional<string>;
  functionType: string;
  bindings: string[];
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
  private ast: Nullable<ParseResult<File>>;
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

  private findParentFunctionClosureScope(
    locToClosureScopeMap: Map<string, ClosureScope>,
    path: NodePath<FunctionClass>,
  ): ClosureScope {
    let curPath = path.parentPath;
    while (curPath) {
      if (
        isFunctionType(curPath.node.type) ||
        curPath.node.type === 'Program'
      ) {
        const parentClosureScope = locToClosureScopeMap.get(
          this.locToStr(curPath.node.loc),
        );
        if (!parentClosureScope) {
          throw utils.haltOrThrow('cannot find parent scope');
        }
        return parentClosureScope;
      }
      if (curPath.parentPath == null) {
        break;
      }
      curPath = curPath.parentPath;
    }
    throw utils.haltOrThrow('cannot find parent scope');
  }

  private buildClosureScopeTree(ast: ParseResult<File>): ClosureScope {
    const root = {
      functionName: null,
      functionType: ast.program.type,
      bindings: [] as string[],
      nestedClosures: [] as ClosureScope[],
      loc: ast.program.loc,
    };

    const locToClosureScopeMap = new Map<string, ClosureScope>();
    locToClosureScopeMap.set(this.locToStr(ast.program.loc), root);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const buildClosureScopeFromFunction = function (
      path: NodePath<FunctionClass>,
    ) {
      // build closure scope
      const closureScope = {
        functionName: 'id' in path.node ? path.node?.id?.name : null,
        functionType: path.node.type,
        bindings: Object.keys(path.scope.bindings),
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
    traverse(ast, {
      FunctionDeclaration: buildClosureScopeFromFunction,
      FunctionExpression: buildClosureScopeFromFunction,
      ObjectMethod: buildClosureScopeFromFunction,
      ClassMethod: buildClosureScopeFromFunction,
      ArrowFunctionExpression: buildClosureScopeFromFunction,
      Program: (path: NodePath<Program>) => {
        root.bindings = Object.keys(path.scope.bindings);
      },
    });

    return root;
  }
}
