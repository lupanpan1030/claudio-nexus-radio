// Test-only resolve hook: while npm workspace links are not installed, map
// @claudio/contracts to the package source. A linked package always wins.
const contractsSource = new URL("../../packages/contracts/src/index.ts", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "@claudio/contracts") return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, { ...context, conditions: [...(context.conditions ?? []), "source"] });
  } catch {
    return { url: contractsSource, shortCircuit: true };
  }
}
