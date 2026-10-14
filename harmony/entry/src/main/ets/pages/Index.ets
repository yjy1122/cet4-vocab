import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .domStorageAccess(true)
        .databaseAccess(true)
        .mixedMode(MixedMode.All)
        .onlineImageAccess(true)
        .zoomAccess(false)
        .width('100%')
        .height('100%')
        .backgroundColor('#ffffff')
    }
    .width('100%')
    .height('100%')
  }
}