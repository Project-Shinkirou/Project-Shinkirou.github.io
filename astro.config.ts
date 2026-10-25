import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Static bilingual portal. Product pages use src/layouts/ProductLayout.astro;
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
      description: 'ShinkiEMU 与 RoukakuEngine 的组织门户 / Organization portal for ShinkiEMU and RoukakuEngine',
      logo: { src: './src/assets/logo-mark.svg', alt: '' },
      favicon: '/favicon.svg',
      defaultLocale: 'zh-cn',
      locales: {
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Project-Shinkirou' }],
      sidebar: [
        {
          label: 'ShinkiEMU',
          items: [
            { label: '产品主页', translations: { en: 'Product page' }, link: '/shinkiemu/' },
            { label: '兼容性', translations: { en: 'Compatibility' }, link: '/shinkiemu/compatibility/' },
            { label: '核心', translations: { en: 'Cores' }, link: '/shinkiemu/cores/' },
            { label: '补丁', translations: { en: 'Patches' }, link: '/shinkiemu/patches/' },
            {
              label: '文档',
              translations: { en: 'Documentation' },
              collapsed: false,
              items: [
                'shinkiemu/docs',
                'shinkiemu/docs/user-guide',
                'shinkiemu/docs/build-and-release',
                {
                  label: '平台与构建矩阵',
                  translations: { en: 'Platform and build matrix' },
                  link: '/shinkiemu/docs/platforms/',
                },
                'shinkiemu/docs/core-abi',
                'shinkiemu/docs/metadata',
                {
                  label: '各核心说明',
                  translations: { en: 'Core notes' },
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
            { label: '产品主页', translations: { en: 'Product page' }, link: '/roukaku/' },
            {
              label: '文档',
              translations: { en: 'Documentation' },
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
      // src/pages/404.astro is the bilingual replacement.
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
