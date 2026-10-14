import { copyFileSync, existsSync } from 'node:fs';
for (const [source,target] of [['wrangler.example.jsonc','wrangler.jsonc'],['wrangler.local.example.jsonc','wrangler.local.jsonc']]) {
  if(existsSync(target)) { console.log('保留已有配置：'+target); continue; }
  copyFileSync(source,target); console.log('已建立本机配置：'+target);
}
