export type AvdProfile = {
  id: string;
  name: string;
  manufacturer: string;
  foldable: boolean;
};
export type AvdSystemImage = { id: string; name: string; abi: string };
export type AvdCatalog = { profiles: AvdProfile[]; images: AvdSystemImage[] };
export type CreateAvdOptions = { name: string; profile: string; image: string };

