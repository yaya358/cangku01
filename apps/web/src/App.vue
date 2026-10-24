<template>
  <n-config-provider
    :theme="darkTheme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <span class="brand__mark" aria-hidden="true">🍺</span>
            <div class="brand__text">
              <strong class="brand__name">酒馆 AI</strong>
              <p class="brand__desc">本地优先的 AI 角色扮演酒馆</p>
            </div>
          </div>

          <nav class="nav">
            <RouterLink class="nav__link" to="/">概览</RouterLink>
            <a class="nav__link" href="/api/health" target="_blank" rel="noreferrer">接口自测</a>
          </nav>
        </header>

        <main class="main">
          <RouterView />
        </main>

        <footer class="footer">
          <span>阶段 1 · 基建 · v{{ appVersion }}</span>
          <span class="footer__sep" aria-hidden="true">|</span>
          <span>Fastify 后端 + Vue3 前端，同仓 pnpm workspace</span>
        </footer>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { APP_VERSION } from '@tavern/shared';
import { NConfigProvider, NMessageProvider, darkTheme, dateZhCN, zhCN } from 'naive-ui';
import type { GlobalThemeOverrides } from 'naive-ui';

const appVersion = APP_VERSION;

/**
 * 主题微调：Naive UI 的 darkTheme 只给基础深色，
 * 这里把主色换成酒馆的琥珀色，并统一圆角与字体，避免组件间风格打架。
 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#e0a75e',
    primaryColorHover: '#eab873',
    primaryColorPressed: '#c98f47',
    primaryColorSuppl: '#e0a75e',
    successColor: '#6cbf8b',
    warningColor: '#e0b35e',
    errorColor: '#d9765f',
    textColorBase: '#ece4d8',
    bodyColor: '#12100e',
    cardColor: '#1d1916',
    modalColor: '#1d1916',
    popoverColor: '#1d1916',
    tableColor: '#1d1916',
    inputColor: '#171412',
    borderColor: '#2c2620',
    dividerColor: '#2c2620',
    borderRadius: '10px',
    fontFamily: "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    fontFamilyMono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  },
};
</script>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 22px;
  border-bottom: 1px solid var(--border);
  background: rgba(18, 16, 14, 0.82);
  backdrop-filter: blur(14px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand__mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: linear-gradient(160deg, #2a2118, #191512);
  font-size: 19px;
}

.brand__name {
  display: block;
  font-size: 15px;
  letter-spacing: 0.04em;
}

.brand__desc {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
}

.nav {
  display: flex;
  gap: 4px;
}

.nav__link {
  padding: 6px 12px;
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 13px;
  transition:
    color 0.18s ease,
    background 0.18s ease;
}

.nav__link:hover {
  background: var(--accent-soft);
  color: var(--accent);
  text-decoration: none;
}

.nav__link.router-link-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 18px 22px 26px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 12px;
}

.footer__sep {
  color: var(--border-strong);
}

@media (max-width: 640px) {
  .brand__desc {
    display: none;
  }

  .footer__sep,
  .footer span:last-child {
    display: none;
  }
}
</style>
