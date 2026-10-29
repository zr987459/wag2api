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

android {
    namespace = "com.wag2api.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.wag2api.app"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // full / lite 两个 flavor：包名与签名一致、versionCode 一致，可互相覆盖
    flavorDimensions += "engine"
    productFlavors {
        create("full") {
            dimension = "engine"
            // 带 Node 引擎，只有 arm64
            ndk { abiFilters += listOf("arm64-v8a") }
            minSdk = 26
            versionNameSuffix = ""
        }
        create("lite") {
            dimension = "engine"
            // 不带 Node，但内置 AIS 引擎（arm64）
            ndk { abiFilters += listOf("arm64-v8a") }
            versionNameSuffix = "-lite"
        }
    }

    signingConfigs {
        create("release") {
            // CI 从 android/keystore/release.p12.enc 解密到此路径。
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
            isMinifyEnabled = false
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
        resources.excludes += setOf("META-INF/*.kotlin_module")
        jniLibs {
            useLegacyPackaging = true
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
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // 只有 full 带 Node 引擎
    "fullImplementation"(project(":engine-node"))
}

// ───────────────────────────────────────────────────────────
// full 包构建前，把仓库根目录的 Node 核心同步进 assets/gateway
// 保证 Linux 版、Docker、Android 共用同一份 src/，不出现两套代码各改各的
// 用 Sync 而非 Copy：删掉的源文件不会残留在目标目录
// ───────────────────────────────────────────────────────────
val syncNodeCore by tasks.registering(Sync::class) {
    from(rootProject.file("../src")) { into("gateway/src") }
    from(rootProject.file("../package.json")) { into("gateway") }
    into(layout.buildDirectory.dir("generated/nodeAssets"))
}

// AGP 只生成按变体命名的任务（preFullDebugBuild / preFullReleaseBuild），
// 挂到全局 preBuild 上最稳，每个变体的 pre 任务都会依赖它
tasks.named("preBuild") { dependsOn(syncNodeCore) }

android.sourceSets.getByName("full") {
    assets.srcDir(layout.buildDirectory.dir("generated/nodeAssets"))
}
