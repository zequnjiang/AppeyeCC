// CLI 入口：`npm run crawl -- [--country th] [--store gp]`（E6 中实现）
const [cmd] = process.argv.slice(2);
if (cmd !== 'crawl') {
  console.error('用法: tsx src/cli.ts crawl [--country xx] [--store gp|ios]');
  process.exit(2);
}
console.log('crawl 命令将在 E6 定时任务 Epic 中实现');
