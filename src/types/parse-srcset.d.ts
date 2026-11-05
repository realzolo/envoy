declare module "parse-srcset" {
  type Candidate = { url: string; w?: number; h?: number; d?: number };
  export default function parseSrcset(value: string): Candidate[];
}
