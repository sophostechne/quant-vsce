import typescriptEslint from 'typescript-eslint';

export default [
	{
		files: ['**/*.ts'],
		plugins: { '@typescript-eslint': typescriptEslint.plugin },
		languageOptions: {
			parser: typescriptEslint.parser,
			ecmaVersion: 2024,
			sourceType: 'module'
		},
		rules: {
			// Carried over from the fork's own rules, which this code was written against.
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			semi: 'warn',
			'@typescript-eslint/naming-convention': ['warn', {
				selector: 'import',
				format: ['camelCase', 'PascalCase']
			}]
		}
	},
	{
		// Generated from the engine, so its shape is not this project's to argue with.
		ignores: ['src/strategy/vocabulary.ts', 'out/**', 'media/**']
	}
];
