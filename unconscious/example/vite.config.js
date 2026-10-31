import unconscious from 'unconscious/vite';

export default {
    define: {
        UC_PERSIST_STORE: JSON.stringify('example'),
        UC_REACTIVE_FRAGMENT: true
    },

    plugins: [unconscious()],

    build: {
        modulePreload: { polyfill: false },
    }
};