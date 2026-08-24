import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/room/:code', name: 'room', component: () => import('./views/RoomView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
