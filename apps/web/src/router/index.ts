import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

/** 让 to.meta.title 有类型，afterEach 里就不用 as 了。 */
declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: { title: '概览' },
  },
  {
    // 兜底路由放最后：匹配不到的一律进 404 页，而不是白屏
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
];

export const router = createRouter({
  // history 模式：地址栏是 /xxx 而不是 /#/xxx，刷新也不会 404（需服务端配合 fallback）
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 酒馆 AI` : '酒馆 AI';
});
