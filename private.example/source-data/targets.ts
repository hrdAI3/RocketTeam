// Placeholder. The runtime will use ../private/source-data/targets.ts when it
// exists; this file is the public fallback so the project compiles + boots
// without any private data. Replace with real names in your private fork.
import type { BootstrapTarget } from '@/bootstrap/extract';

export const DEFAULT_TARGETS: BootstrapTarget[] = [
  { name: '张三', dept: '研发', role: '产品负责人 + 研发负责人', join_date: null },
  { name: '李四', dept: '产品', role: '产品经理', join_date: null },
  { name: '王五', dept: '产品', role: '产品经理', join_date: null },
  { name: '赵六', dept: '产品', role: '产品经理', join_date: null }
];
