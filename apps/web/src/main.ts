import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from '@/App.vue';
import { router } from '@/router';
import '@/styles/main.css';

const app = createApp(App);

// Pinia 必须先装：路由守卫与页面里都会用到 store
app.use(createPinia());
app.use(router);

app.mount('#app');
