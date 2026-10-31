import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 唯一版本来源
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val appVersionCode = versionProps.getProperty("VERSION_CODE").trim().toInt()
val appVersionName = versionProps.getProperty("VERSION_NAME").trim()

// AIS 后端：webview（默认，系统 WebView 实现，不打包 libaistudio2api.so）或 go（-PaisBackend=go，Go + SpiderMonkey 子进程）
val aisBackend = ((project.findProperty("aisBackend") as String?) ?: "webview").trim().lowercase()

android {
    namespace = "com.wag2api.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.wag2api.app"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        // v2：一个 APK、没有 Node。只剩内置 AIS 引擎（arm64 静态二进制）
        ndk { abiFilters += listOf("arm64-v8a") }
        // 只保留中英文资源，去掉依赖库带来的几十种语言
        resourceConfigurations += listOf("zh", "en")
        buildConfigField("String", "AIS_BACKEND", "\"$aisBackend\"")
    }

    testOptions {
        // JVM 单测：android.* 调用返回默认值（单测只覆盖纯 JVM 的协议代码）
        unitTests.isReturnDefaultValues = true
    }

    signingConfigs {
        create("release") {
            // CI 从 app/signing/release.p12.enc 解密到此路径。
            // 必须固定同一个密钥库，否则每次构建签名不同，手机无法覆盖安装。
            val ks = rootProject.file("keystore/release.p12")
            if (ks.exists()) {
                storeFile = ks
                storeType = "pkcs12"
                storePassword = System.getenv("KS_PW") ?: ""
                keyAlias = System.getenv("KS_ALIAS") ?: "ag"
                keyPassword = System.getenv("KS_PW") ?: ""
            }
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            val hasKs = rootProject.file("keystore/release.p12").exists() &&
                    !System.getenv("KS_PW").isNullOrEmpty()
            // CI 环境打包 APK 时必须用正式签名，否则每次签名不同会导致无法覆盖安装。
            // 注意：只编译 Kotlin 的检查任务不涉及签名，不触发此保护。
            val inCi = !System.getenv("GITHUB_ACTIONS").isNullOrEmpty()
            val packagingTask = gradle.startParameter.taskNames.any {
                it.contains("assemble", ignoreCase = true) || it.contains("bundle", ignoreCase = true)
            }
            if (inCi && packagingTask && !hasKs) {
                throw GradleException(
                    "CI 环境缺少固定签名密钥库（keystore/release.p12 或 KS_PW），" +
                    "继续构建会导致签名不一致、手机无法覆盖安装。已中止。"
                )
            }
            signingConfig = if (hasKs) signingConfigs.getByName("release")
                            else signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/*.kotlin_module",
            "META-INF/*.version",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
            "kotlin/**",
            "DebugProbesKt.bin"
        )
        jniLibs {
            // 注意：libaistudio2api.so 不是 JNI 库，而是 AisEngine 用 ProcessBuilder 直接 exec 的可执行文件。
            // useLegacyPackaging=false 时安装器不会把 .so 解压到 nativeLibraryDir，文件不存在就无法 exec，
            // 而 Android 10+ 又禁止从 filesDir 执行文件，所以这里必须保持 true（合同 M5 条目的例外，见 PR 说明）。
            useLegacyPackaging = true
            // WebView 版 AIS 不需要 Go 二进制：即使本地 jniLibs 里有，也不打进 APK
            if (aisBackend == "webview") excludes += setOf("**/libaistudio2api.so")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // MainActivity 继承 AppCompatActivity、主题继承 Theme.AppCompat，暂时保留；
    // 换成平台 Activity + android:Theme.Material 后即可删掉（会连带去掉 androidx.core 等十几个库）
    implementation("androidx.appcompat:appcompat:1.6.1")
    // M3 UpstreamFetch.client 与 EngineRouter 用；全局只建一个 OkHttpClient
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // WebView 版 AIS：多 Profile（每账号独立 Cookie）、WebMessageListener、去掉 X-Requested-With、改写 UA Client Hints
    implementation("androidx.webkit:webkit:1.11.0")

    testImplementation("junit:junit:4.13.2")
    // Android 自带的 org.json 在 JVM 单测里是空桩，单测用真实实现
    testImplementation("org.json:json:20231013")
    // 已删：core-ktx（无 ktx 扩展调用，通知改平台 API）、material（无引用）、
    //       okhttp-sse（无引用）、kotlinx-coroutines（合同规定不用协程）
}
