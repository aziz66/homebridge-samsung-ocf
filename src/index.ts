import type { API } from "homebridge";
import { PLATFORM_NAME } from "./settings";
import { SamsungOcfPlatform } from "./platform";

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, SamsungOcfPlatform);
};
