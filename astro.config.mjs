import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://langcraft-flux.github.io',
  base: '/openclaw-deep-dive',
  integrations: [
    starlight({
      title: 'OpenClaw: Under the Hood',
      description: 'A 10-chapter deep dive into OpenClaw architecture — by LangCraft',
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/Footer.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/langcraft-flux/openclaw-deep-dive' },
      ],
      sidebar: [
        {
          label: 'Introduction',
          link: '/intro',
        },
        {
          label: 'Chapters',
          items: [
            { label: '1. Gateway Architecture', link: '/chapters/01-gateway-architecture' },
            { label: '2. Workspace Structure', link: '/chapters/02-workspace-structure' },
            { label: '3. The Agent Loop', link: '/chapters/03-agent-loop' },
            { label: '4. Session Management', link: '/chapters/04-session-management' },
            { label: '5. Channel & Account Model', link: '/chapters/05-channel-account-model' },
            { label: '6. Multi-Agent Routing', link: '/chapters/06-multi-agent-routing' },
            { label: '7. Memory System', link: '/chapters/07-memory-system' },
            { label: '8. Skills & Tools', link: '/chapters/08-skills-and-tools' },
            { label: '9. Automation', link: '/chapters/09-automation' },
            { label: '10. Security & Permissions', link: '/chapters/10-security-permissions' },
          ],
        },
      ],
    }),
  ],
});
