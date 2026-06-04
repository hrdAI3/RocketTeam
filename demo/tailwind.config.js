/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./demo/index.html'],
  theme: {
    extend: {
      colors: {
        paper:  { DEFAULT:'#FAF9F5', card:'#FFFFFF', subtle:'#F2EFE6', deep:'#EDE9DB' },
        ink:    { DEFAULT:'#1F1F1C', soft:'#2A2A26', muted:'#5A5A57', quiet:'#8A8782', ghost:'#B8B5AE' },
        rule:   { DEFAULT:'#E8E3D5', strong:'#DBD5C3', soft:'#F0EBDC' },
        coral:  { DEFAULT:'#D97757', deep:'#C76A4D', subtle:'#FCEEE2', mute:'#F5DCC9' },
        forest: '#5C7F5A', amber:'#D49B40', rust:'#B85850', sky:'#5681A8'
      },
      fontFamily: {
        sans:  ['Inter','-apple-system','BlinkMacSystemFont','Segoe UI','PingFang SC','Microsoft YaHei','Helvetica Neue','Arial','sans-serif'],
        mono:  ['JetBrains Mono','SFMono-Regular','Menlo','Consolas','monospace'],
        serif: ['Source Serif 4','Songti SC','SimSun','Georgia','serif']
      }
    }
  }
};
