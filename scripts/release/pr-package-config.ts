export type Package = {
  dir: string;
  name: string;
  group?: string;
  project: string;
  install: string;
  readme?: string;
  submodule: boolean;
  artifact: string;
  commit: string;
  short: string;
  tags: string[];
};

export type PrPackagePlan = {
  packages: Package[];
  publishable_names: string[];
  install_host: string;
};
