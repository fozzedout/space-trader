/**
 * Type definitions for packages that may not have perfect types in this environment
 */

declare module "seedrandom" {
  export default function seedrandom(seed?: string): () => number;
}
