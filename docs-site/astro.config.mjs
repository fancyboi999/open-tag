// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.getopentag.com',
	integrations: [
		sitemap(),
		starlight({
			title: 'open-tag',
			description: 'The open-source workspace where humans and AI agents work as one team. Self-hosted, Slack-style multi-agent collaboration — Claude Code, Codex, Copilot and more.',
			logo: {
				light: './src/assets/logo-light.svg',
				dark: './src/assets/logo-dark.svg',
				replacesTitle: false,
			},
			favicon: '/favicon.svg',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/fancyboi999/open-tag',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/fancyboi999/open-tag/edit/main/docs-site/',
			},
			head: [
				{
					tag: 'meta',
					attrs: {
						property: 'og:image',
						content: 'https://docs.getopentag.com/og.png',
					},
				},
				{
					tag: 'meta',
					attrs: {
						name: 'twitter:card',
						content: 'summary_large_image',
					},
				},
				{
					tag: 'meta',
					attrs: {
						name: 'twitter:image',
						content: 'https://docs.getopentag.com/og.png',
					},
				},
			],
			sidebar: [
				{
					label: 'Introduction',
					items: [
						{ label: 'What is open-tag?', slug: 'index' },
					],
				},
				{
					label: 'Getting Started',
					items: [
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Self-Host Guide', slug: 'getting-started/self-host' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'Architecture', slug: 'concepts/architecture' },
						{ label: 'Features', slug: 'concepts/features' },
						{ label: 'Authorization & Roles', slug: 'concepts/authorization' },
					],
				},
			],
		}),
	],
});
