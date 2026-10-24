<template>
  <section class="not-found">
    <p class="not-found__code">404</p>
    <h1 class="not-found__title">这里没有酒保</h1>
    <p class="not-found__desc">
      你访问的地址
      <code>{{ route.fullPath }}</code> 不存在。可能是拼错了，也可能是该页面还没建出来。
    </p>
    <RouterLink class="not-found__link" to="/">回到概览</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();
</script>

<style scoped>
.not-found {
  display: flex;
  max-width: 520px;
  margin: 8vh auto 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.not-found__code {
  font-family: var(--font-mono);
  font-size: 64px;
  font-weight: 600;
  line-height: 1;
  color: var(--border-strong);
}

.not-found__title {
  font-size: 22px;
}

.not-found__desc {
  color: var(--text-dim);
  font-size: 13px;
}

.not-found__desc code {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft);
  color: var(--accent);
}

.not-found__link {
  margin-top: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--accent);
  font-size: 13px;
}

.not-found__link:hover {
  background: var(--accent-soft);
  text-decoration: none;
}
</style>
