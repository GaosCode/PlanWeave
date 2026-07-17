export const SHARED_RESOURCE_OVERFLOW_LIMIT = 3;

export type SharedResourceColor = {
  dot: string;
  halo: string;
};

const SHARED_RESOURCE_PALETTE: SharedResourceColor[] = Array.from({ length: 12 }, (_, index) => ({
  dot: `var(--shared-resource-color-${index})`,
  halo: `var(--shared-resource-color-${index}-halo)`
}));

function hashSharedResourceName(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function sharedResourceColor(name: string): SharedResourceColor {
  return SHARED_RESOURCE_PALETTE[hashSharedResourceName(name) % SHARED_RESOURCE_PALETTE.length]!;
}
