/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {CDPSession, Page} from 'puppeteer';
import type {AnyValue, Nullable} from '@memlab/core';

import {config, info} from '@memlab/core';
import ScriptManager from './ScriptManager';

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
  private scriptManager: ScriptManager;

  constructor(page: Page) {
    this.page = page;
    this.requestCache = new Map();
    this.scriptManager = new ScriptManager();
  }

  public setCDPSession(session: CDPSession): void {
    this.cdpSession = session;
  }

  private networkLog(msg: string): void {
    if (config.verbose) {
      info.lowLevel(msg);
    }
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
      // when extending the interception scope, make sure
      // also update the resourceTypeToSuffix function in ScriptManager
      patterns: [
        // .js scripts
        ...patterns.map(
          pattern =>
            ({
              urlPattern: pattern,
              resourceType: 'Script',
              interceptionStage: 'HeadersReceived',
            }) as AnyValue,
        ),
        // .css stylesheets
        ...patterns.map(
          pattern =>
            ({
              urlPattern: pattern,
              resourceType: 'Stylesheet',
              interceptionStage: 'HeadersReceived',
            }) as AnyValue,
        ),
        // .html documents
        ...patterns.map(
          pattern =>
            ({
              urlPattern: pattern,
              resourceType: 'Document',
              interceptionStage: 'HeadersReceived',
            }) as AnyValue,
        ),
      ],
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
          newBody = bodyData;
          try {
            if (resourceType === 'Script') {
              newBody = await this.scriptManager.rewriteScript(bodyData, {
                url: request.url,
                resourceType,
              });
            }
          } catch (e) {
            this.networkLog(
              `Failed to process ${request.url} {interception id: ${interceptionId}}: ${e}`,
            );
          }
          requestCache.set(response.body, newBody as string);
          this.scriptManager.logScript(request.url, newBody, resourceType);
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
