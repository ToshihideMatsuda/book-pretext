import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        game: 'game.html',
        fish: 'fish.html',
        fish_nopretext: 'fish_nopretext.html',
      },
    },
  },
})
