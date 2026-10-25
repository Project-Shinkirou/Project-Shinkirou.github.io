import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Static trilingual portal (zh-cn, en, ja). Product pages use src/layouts/ProductLayout.astro;
// documentation stays on Starlight. Data and product docs are prepared by
// `scripts/prebuild.ts` (run through `npm run prepare-site`) before Astro runs.
export default defineConfig({
  site: 'https://project-shinkirou.github.io',
  trailingSlash: 'always',
  redirects: {
    '/': '/zh-cn/',
  },
  integrations: [
    starlight({
      title: 'Project-Shinkirou',
      description:
        'ShinkiEMU 与 RoukakuEngine 的组织门户 / Organization portal for ShinkiEMU and RoukakuEngine / ShinkiEMU と RoukakuEngine の組織ポータル',
      logo: { src: './src/assets/logo-mark.svg', alt: '' },
      favicon: '/favicon.svg',
      defaultLocale: 'zh-cn',
      locales: {
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Project-Shinkirou' }],
      sidebar: [
        {
          label: 'ShinkiEMU',
          items: [
            { label: '产品主页', translations: { en: 'Product page', ja: '製品ページ' }, link: '/shinkiemu/' },
            { label: '兼容性', translations: { en: 'Compatibility', ja: '互換性' }, link: '/shinkiemu/compatibility/' },
            { label: '核心', translations: { en: 'Cores', ja: 'コア' }, link: '/shinkiemu/cores/' },
            { label: '补丁', translations: { en: 'Patches', ja: 'パッチ' }, link: '/shinkiemu/patches/' },
            {
              label: '文档',
              translations: { en: 'Documentation', ja: 'ドキュメント' },
              collapsed: false,
              items: [
                'shinkiemu/docs',
                'shinkiemu/docs/user-guide',
                'shinkiemu/docs/build-and-release',
                {
                  label: '平台与构建矩阵',
                  translations: { en: 'Platform and build matrix', ja: 'プラットフォームとビルドマトリクス' },
                  link: '/shinkiemu/docs/platforms/',
                },
                'shinkiemu/docs/core-abi',
                'shinkiemu/docs/metadata',
                {
                  label: '各核心说明',
                  translations: { en: 'Core notes', ja: 'コア別の説明' },
                  collapsed: true,
                  items: [{ autogenerate: { directory: 'shinkiemu/docs/cores' } }],
                },
              ],
            },
          ],
        },
        {
          label: 'RoukakuEngine',
          items: [
            { label: '产品主页', translations: { en: 'Product page', ja: '製品ページ' }, link: '/roukaku/' },
            {
              label: '文档',
              translations: { en: 'Documentation', ja: 'ドキュメント' },
              collapsed: false,
              items: [{ autogenerate: { directory: 'roukaku/docs' } }],
            },
          ],
        },
      ],
      // theme.css holds the shared mirage-night tokens; starlight.css maps them
      // onto Starlight's variables.
      customCss: ['./src/styles/theme.css', './src/styles/starlight.css'],
      credits: false,
      lastUpdated: false,
      // src/pages/404.astro is the trilingual replacement.
      disable404Route: true,
      pagination: false,
      components: {
        Banner: './src/components/starlight/Banner.astro',
        Footer: './src/components/starlight/Footer.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
      },
    }),
  ],
});
