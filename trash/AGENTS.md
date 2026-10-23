# AGENTS.md

## Project Stack

- React
- TypeScript
- Three.js
- Vite
- Blender (GLB/GLTF models)
- TailwindCSS
## Coding Rules

- Write clean, readable, and maintainable TypeScript.
- Use functional React components and hooks.
- Avoid `any` and unnecessary code duplication.
- Keep components and functions small.
- Follow the existing project structure.
- Avoid unnecessary dependencies.
- Clean up Three.js resources, event listeners, and animation loops.

## Comment Rules

- Write clear, professional English comments.
- Explain **why** code exists, not what obvious code does.
- Use JSDoc for complex functions and reusable utilities.
- Explain complicated logic, calculations, and workarounds.
- Avoid excessive, redundant, or outdated comments.
- Update comments when changing related code.

## Prettier Rules

- **Always run Prettier after modifying code.**
- Follow the existing `.prettierrc` configuration.
- Format only modified files when possible.
- Never leave modified code unformatted.

```bash
npx prettier --write <modified-files>
```

## Before Finishing

1. Review modified code.
2. Run Prettier.
3. Run TypeScript and ESLint checks when available.
4. Fix errors introduced by the changes.
5. Briefly summarize what changed and which checks passed.

**Important:** Never claim formatting or tests passed unless they were actually executed.