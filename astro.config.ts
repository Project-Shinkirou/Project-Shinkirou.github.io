import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Static bilingual portal. Data and product docs are prepared by
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
            { label: '概览与下载', translations: { en: 'Overview & download' }, link: '/shinkiemu/' },
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
          items: [{ autogenerate: { directory: 'roukaku' } }],
        },
      ],
      customCss: ['./src/styles/custom.css'],
      credits: false,
      lastUpdated: false,
      // src/pages/404.astro is the bilingual replacement.
      disable404Route: true,
      pagination: false,
      components: {
        Banner: './src/components/Banner.astro',
        Footer: './src/components/Footer.astro',
      },
    }),
  ],
});
