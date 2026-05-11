import { redirect } from 'next/navigation';

// 时间线 已重构为 数据接入 (/sources). 保留旧路径作为重定向，避免外链断裂。
export default function TimelineRedirect() {
  redirect('/sources');
}
