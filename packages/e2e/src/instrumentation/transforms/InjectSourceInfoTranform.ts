/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall mitigation_infra
 */
import type {
  ArrowFunctionExpression,
  ClassMethod,
  FunctionDeclaration,
  FunctionExpression,
  ObjectMethod,
} from '@babel/types';
import type {NodePath} from '@babel/traverse';
import type {ParseResult} from '@babel/parser';
import type {File} from '@babel/types';
import type {RewriteScriptOption} from '../ScriptRewriteManager';

import traverse from '@babel/traverse';
import template from '@babel/template';

import BaseAstTransform from '../BaseAstTransform';

export default class InjectSourceInfoTranform extends BaseAstTransform {
  public async transform(
    ast: ParseResult<File>,
    options: RewriteScriptOption = {},
  ): Promise<void> {
    const url = options.url ?? '';
    const instrumentFunction = function <
      T extends
        | FunctionDeclaration
        | FunctionExpression
        | ObjectMethod
        | ClassMethod
        | ArrowFunctionExpression,
    >(path: NodePath<T>) {
      const statements = [`var __memlab_file_$$ = '${url}';`];
      if (path.node.loc) {
        const {start, end} = path.node.loc;
        statements.push(
          `var __memlab_loc_$$ = '${start.line}:${start.column}:${end.line}:${end.column}';`,
        );
      }
      statements.push('function __memlab_use_$$() { __memlab_file_$$ += ""; }');
      if ('id' in path.node && path.node.id?.name) {
        statements.push(`var __memlab_scope_$$ = '${path.node.id?.name}';`);
      }
      const codeToInsert = template(statements.join(''), {
        placeholderPattern: false,
      });
      if (path.node.body.type === 'BlockStatement') {
        const blockStatementBody = path.node.body.body;
        if (Array.isArray(codeToInsert)) {
          blockStatementBody.unshift(...codeToInsert);
        } else {
          const newCode = codeToInsert();
          if (Array.isArray(newCode)) {
            blockStatementBody.unshift(...newCode);
          } else {
            blockStatementBody.unshift(newCode);
          }
        }
      }
    };
    traverse(ast, {
      FunctionDeclaration: instrumentFunction,
      FunctionExpression: instrumentFunction,
      ObjectMethod: instrumentFunction,
      ClassMethod: instrumentFunction,
      ArrowFunctionExpression: instrumentFunction,
    });
  }
}
