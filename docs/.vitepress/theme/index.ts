import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import type { Theme } from "vitepress";
import HomeDemo from "./HomeDemo.vue";
import HomeInstall from "./HomeInstall.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-features-after": () => [h(HomeDemo), h(HomeInstall)],
    });
  },
} satisfies Theme;
