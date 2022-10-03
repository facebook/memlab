/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {Nullable} from '@memlab/core';
import type {Page, CDPSession} from 'puppeteer';
import type {RewriteScriptOption} from './instrumentation/ScriptRewriteManager';

import {config, info} from '@memlab/core';
import ScriptRewriteManager from './instrumentation/ScriptRewriteManager';

// https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBodyForInterception
type NetworkResponse = {
  // Response body
  body: string;
  // True, if content was sent as base64
  base64Encoded: boolean;
};

const patterns = ['*'];

export default class NetworkManager {
  private cdpSession: Nullable<CDPSession> = null;
  private page: Page;
  private requestCache: Map<string, string>;
  private scriptRewriteManager: ScriptRewriteManager;

  constructor(page: Page) {
    this.page = page;
    this.requestCache = new Map();
    this.scriptRewriteManager = new ScriptRewriteManager();
  }

  public setCDPSession(session: CDPSession): void {
    this.cdpSession = session;
  }

  private networkLog(msg: string): void {
    if (config.verbose) {
      info.lowLevel(msg);
    }
  }

  private async rewriteScript(
    script: string,
    options: RewriteScriptOption,
  ): Promise<string> {
    return await this.scriptRewriteManager.rewriteScript(script, options);
  }

  public async interceptScript(): Promise<void> {
    const session = this.cdpSession;
    if (!session) {
      info.warning(
        'Network manager does not have connection to Chrome DevTools.',
      );
      return;
    }
    const requestCache = this.requestCache;

    await session.send('Network.enable');
    await session.send('Network.setRequestInterception', {
      patterns: patterns.map(pattern => ({
        urlPattern: pattern,
        resourceType: 'Script',
        interceptionStage: 'HeadersReceived',
      })),
    });

    session.on(
      'Network.requestIntercepted',
      async ({interceptionId, request, responseHeaders, resourceType}) => {
        this.networkLog(
          `Intercepted ${request.url} {interception id: ${interceptionId}}`,
        );

        const response = (await session.send(
          'Network.getResponseBodyForInterception',
          {interceptionId},
        )) as NetworkResponse;

        // responseHeaders could be null if requesting from
        // local files (i.e., urls starting with 'file:///')
        let contentType = null;
        if (responseHeaders) {
          const contentTypeHeader =
            Object.keys(responseHeaders).find(
              k => k.toLowerCase() === 'content-type',
            ) ?? '';
          contentType = responseHeaders[contentTypeHeader];
        }

        let newBody = '';

        if (requestCache.has(response.body)) {
          newBody = requestCache.get(response.body) as string;
        } else {
          const bodyData = response.base64Encoded
            ? atob(response.body)
            : response.body;
          try {
            if (resourceType === 'Script') {
              newBody = await this.rewriteScript(bodyData, {
                url: request.url,
                resourceType,
              });
            }
          } catch (e) {
            this.networkLog(
              `Failed to process ${request.url} {interception id: ${interceptionId}}: ${e}`,
            );
            newBody = bodyData;
          }

          requestCache.set(response.body, newBody as string);
        }

        const newHeaders = [
          'Date: ' + new Date().toUTCString(),
          'Connection: closed',
          'Content-Length: ' + newBody.length,
        ];
        if (contentType) {
          newHeaders.push('Content-Type: ' + contentType);
        }

        this.networkLog(`Continuing interception ${interceptionId}`);
        const rawResponse = btoa(
          ['HTTP/1.1 200 OK', ...newHeaders, '', newBody].join('\r\n'),
        );
        session.send('Network.continueInterceptedRequest', {
          interceptionId,
          rawResponse,
        });
      },
    );
  }
}
