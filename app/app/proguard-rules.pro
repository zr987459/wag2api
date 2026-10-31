# wag2api v2 release 混淆/裁剪规则
# - org.json 是系统类，不需要 keep
# - Service / Receiver / Activity 由 AGP 按 Manifest 自动 keep
# - OkHttp 4.12 自带 consumer rules

# 崩溃栈保留行号，便于排查
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# WebView JS 接口（目前没用到，留着防以后加了被裁）
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 去掉 Log.v / Log.d（i/w/e 保留，AIS 日志走 Log.i）
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
}

# OkHttp 可选依赖（安卓上不存在），避免 R8 报缺类
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
