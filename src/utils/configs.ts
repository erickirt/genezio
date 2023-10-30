export const tsconfig = {
  compilerOptions: {
      target: "ES2020",
      module: "ES2020",
      moduleResolution: "node",
      lib: [
          "es6",
          "dom"
      ],
      outDir: "build",
      rootDir: ".",
      strict: true,
      noImplicitAny: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      types: [
          "node"
      ]
  },
  include: [
      "**/*"
  ],
}
;

export const regions = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-3",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "sa-east-1"
];

export const regionNames = [
"US East (N. Virginia)",
"US East (Ohio)",
"US West (N. California)",
"US West (Oregon)",
"Asia Pacific (Mumbai)",
"Asia Pacific (Osaka)",
"Asia Pacific (Seoul)",
"Asia Pacific (Singapore)",
"Asia Pacific (Sydney)",
"Asia Pacific (Tokyo)",
"Canada (Central)",
"Europe (Frankfurt)",
"Europe (Ireland)",
"Europe (London)",
"Europe (Paris)",
"Europe (Stockholm)",
"South America (São Paulo)"
];

export const regionsNames = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-3",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "sa-east-1"
];


