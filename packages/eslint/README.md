# `@archer/eslint`

Shared ESLint flat config and Prettier options for Archer packages.

```js
import archer from '@archer/eslint';

export default [...archer];
```

TypeScript consumers need a `tsconfig.json` that includes every linted
TypeScript file. The config uses ESLint's project service and resolves the
nearest project from the consumer's working directory.

Prettier consumers can reuse the same options:

```js
export { default } from '@archer/eslint/prettier';
```
