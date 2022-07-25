/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 * @oncall ws_labs
 */
// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'memlab',
  tagline:
    'Analyzes JavaScript heap and finds memory leaks in browser and node.js',
  url: 'https://facebookincubator.github.io/',
  baseUrl: '/memlab/',
  organizationName: 'facebookincubator',
  projectName: 'memlab',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/favicon.ico',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  plugins: [
    [
      '@memlab/memlab-docusaurus-plugin-typedoc',
      {
        entryPoints: [
          '../packages/api/src/index.ts',
          '../packages/heap-analysis/src/index.ts',
          '../packages/core/src/index.ts',
        ],
        categorizeByGroup: false,
        cleanOutputDir: true,
        exclude: '**/*.d.ts',
        excludePrivate: true,
        excludeProtected: true,
        excludeInternal: true,
        tsconfig: '../tsconfig.json',
        out: 'api',
        readme: 'none',
      },
    ],
    [
      '@docusaurus/plugin-google-gtag',
      {
        trackingID: 'G-LGBX08ST0E',
        anonymizeIP: true,
      },
    ],
  ],
  presets: [
    [
      '@docusaurus/preset-classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      {
        docs: {
          breadcrumbs: false,
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl:
            'https://github.com/facebookincubator/memlab/blob/main/website',
        },
        blog: {
          showReadingTime: true,
          editUrl: 'https://github.com/facebookincubator/memlab/website/blog',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    {
      navbar: {
        title: 'memlab',
        logo: {
          alt: 'memlab Project Logo',
          src: 'img/logo.png',
        },
        items: [
          {
            type: 'doc',
            docId: 'intro',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/facebookincubator/memlab',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Guides',
            items: [
              {
                label: 'Getting Started',
                to: 'docs/intro',
              },
              {
                label: 'How it works',
                to: '/docs/how-memlab-works',
              },
            ],
          },
          {
            title: 'Community',
            items: [
              {
                label: 'Stack Overflow',
                href: 'https://stackoverflow.com/questions/tagged/memlab',
              },
              {
                label: 'Twitter',
                href: '/under-construction',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                // need to update with our repo url
                href: 'https://github.com/facebookincubator/memlab',
              },
            ],
          },
          {
            title: 'Legal',
            // Please do not remove the privacy and terms.
            // It's a legal requirement.
            items: [
              {
                label: 'Privacy',
                href: 'https://opensource.facebook.com/legal/privacy/',
              },
              {
                label: 'Terms',
                href: 'https://opensource.facebook.com/legal/terms/',
              },
              {
                label: 'Data Policy',
                href: 'https://opensource.facebook.com/legal/data-policy/',
              },
              {
                label: 'Cookie Policy',
                href: 'https://opensource.facebook.com/legal/cookie-policy/',
              },
            ],
          },
        ],
        logo: {
          alt: 'Facebook Open Source Logo',
          src: 'img/oss_logo.png',
          href: 'https://opensource.facebook.com',
        },
        // Please do not remove the credits, help to publicize Docusaurus :)
        copyright: `Copyright © ${new Date().getFullYear()}
          Facebook, Inc. Built with Docusaurus.`,
      },
      algolia: {
        // The application ID provided by Algolia
        appId: 'OLRNUAX6MR',
        // Public API key: it is safe to commit it
        apiKey: 'f7470165b69610e2eca6a903e6b7683d',
        indexName: 'memlab doc site',
        contextualSearch: false,
      },
    },
};

module.exports = config;
