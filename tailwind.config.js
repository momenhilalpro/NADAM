/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        amazon: {
          navy: '#131921',
          lightNavy: '#232F3E',
          yellow: '#FEBD69',
          orange: '#FF9900',
          orangeHover: '#E68A00',
          lightBg: '#EAEDED',
          grayText: '#565959',
          blueLink: '#007185',
          redDeal: '#CC0C39',
          greenStock: '#007600'
        }
      },
      fontFamily: {
        cairo: ['Cairo', 'sans-serif']
      }
    }
  },
  plugins: []
};
