# nodejs-mobile JNI 入口，禁止混淆
-keep class com.wag2api.engine.NodeService { *; }
-keepclasseswithmembernames class * { native <methods>; }
