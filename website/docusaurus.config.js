/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'memlab',
  tagline:
    'Analyzes JavaScript heap and finds memory leaks in browser and node.js',
  url: 'https://facebook.github.io/',
  baseUrl: '/memlab/',
  organizationName: 'facebook',
  projectName: 'memlab',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/logo.svg',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  clientModules: [require.resolve('@fontsource-variable/geist')],
  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: [
          '../packages/api/src/index.ts',
          '../packages/heap-analysis/src/index.ts',
          '../packages/core/src/index.ts',
          // '../packages/lens/src/index.ts',
          // '../packages/e2e/src/index.ts',
        ],
        categorizeByGroup: false,
        cleanOutputDir: true,
        exclude: '**/*.d.ts',
        excludePrivate: true,
        excludeProtected: true,
        excludeInternal: true,
        tsconfig: '../tsconfig.json',
        out: 'docs/api',
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
          editUrl: 'https://github.com/facebook/memlab/blob/main/website',
        },
        blog: {
          showReadingTime: true,
          editUrl: 'https://github.com/facebook/memlab/website/blog',
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
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: false,
      },
      prism: {
        theme: require('prism-react-renderer/themes/github'),
        darkTheme: require('prism-react-renderer/themes/vsDark'),
      },
      navbar: {
        title: 'memlab',
        logo: {
          alt: 'memlab logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'doc',
            docId: 'intro',
            position: 'left',
            label: 'Docs',
          },
          {
            type: 'doc',
            docId: 'guides/guides-find-leaks',
            position: 'left',
            label: 'Guides',
          },
          {
            type: 'doc',
            docId: 'api/index',
            position: 'left',
            label: 'API',
          },
          {
            type: 'doc',
            docId: 'mcp-server',
            position: 'left',
            label: 'MCP',
          },
          {
            href: 'https://github.com/facebook/memlab',
            position: 'right',
            className: 'header-github-link',
            'aria-label': 'GitHub repository',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Getting Started',
                to: 'docs/getting-started',
              },
              {
                label: 'How it works',
                to: 'docs/how-memlab-works',
              },
              {
                label: 'CLI',
                to: 'docs/cli/CLI-commands',
              },
              {
                label: 'MCP Server',
                to: 'docs/mcp-server',
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
                href: 'https://twitter.com/memlabjs',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/facebook/memlab',
              },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/memlab',
              },
              {
                label: 'Engineering blog',
                href: 'https://engineering.fb.com/2022/09/12/open-source/memlab/',
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
                href: 'https://opensource.fb.com/legal/privacy/',
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              {
                label: 'Terms',
                href: 'https://opensource.fb.com/legal/terms/',
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              {
                label: 'Data Policy',
                href: 'https://opensource.fb.com/legal/data-policy/',
              },
              {
                label: 'Cookie Policy',
                href: 'https://opensource.fb.com/legal/cookie-policy/',
              },
            ],
          },
        ],
        logo: {
          alt: 'Meta Open Source Logo',
          src: 'img/oss_logo.png',
          href: 'https://opensource.facebook.com',
        },
        copyright: `Copyright © ${new Date().getFullYear()} Meta Platforms, Inc.`,
      },
      algolia: {
        // The application ID provided by Algolia
        appId: 'O3G3EAJFFW',
        // Public API key: it is safe to commit it
        apiKey: 'ad4054e5f8136d8d79b1124ba77ada30',
        indexName: 'memlab',
        contextualSearch: false,
      },
    },
  customFields: {
    showAddLogoButton: false,
    users: [
      {
        caption: 'Facebook',
        imageUrl: 'img/users/fb.png',
        infoUrl: 'https://www.facebook.com',
        pinned: true,
      },
      {
        caption: 'Instagram',
        imageUrl: 'img/users/instagram.svg',
        infoUrl: 'https://www.instagram.com',
        pinned: true,
      },
      {
        caption: 'Messenger',
        imageUrl: 'img/users/messenger.svg',
        infoUrl: 'https://www.messenger.com',
        pinned: true,
      },
      {
        caption: 'WhatsApp Web',
        imageUrl: 'img/users/whatsapp.svg',
        infoUrl: 'https://web.whatsapp.com',
        pinned: true,
      },
      {
        caption: 'Workplace',
        imageUrl: 'img/users/workplace.svg',
        infoUrl: 'https://www.workplace.com/features',
        pinned: true,
      },
    ],
  },
};

module.exports = config;
