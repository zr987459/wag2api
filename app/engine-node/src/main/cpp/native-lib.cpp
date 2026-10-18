// 在 App 进程内启动 Node.js（nodejs-mobile），运行网关 server.mjs
//
// 与上游 wag2api 的差异：
//  - 允许注入 HOST / DATA_DIR / ENGINE_TOKEN，配合前门统一入口
//  - 白名单收紧，除下列变量外一律不传给 Node 进程
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>

#include "node.h"

static int pipeOut[2];
static int pipeErr[2];

static void *pump(void *arg) {
    int fd = *(int *) arg;
    int prio = (fd == pipeErr[0]) ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, "Wag2apiNode", buf);
    }
    return nullptr;
}

static void redirectStdio() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipeOut);
    pipe(pipeErr);
    dup2(pipeOut[1], STDOUT_FILENO);
    dup2(pipeErr[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, pump, &pipeOut[0]);
    pthread_create(&t2, nullptr, pump, &pipeErr[0]);
    pthread_detach(t1);
    pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_wag2api_engine_NodeService_startNode(JNIEnv *env, jobject self,
                                              jobjectArray args, jobjectArray envs,
                                              jstring rootDir) {
    const char *rd = env->GetStringUTFChars(rootDir, nullptr);
    std::string root(rd);
    env->ReleaseStringUTFChars(rootDir, rd);
    (void) self;
    (void) args; // 参数固定，不接受外部传入

    jsize envCount = env->GetArrayLength(envs);
    for (jsize i = 0; i < envCount; i++) {
        auto js = (jstring) env->GetObjectArrayElement(envs, i);
        const char *kv = env->GetStringUTFChars(js, nullptr);
        std::string s(kv);
        env->ReleaseStringUTFChars(js, kv);
        env->DeleteLocalRef(js);

        size_t eq = s.find('=');
        if (eq == std::string::npos) continue;
        std::string k = s.substr(0, eq);
        // 只放行这几个变量，防止注入 NODE_OPTIONS 之类
        if (k == "PORT" || k == "HOST" || k == "ADMIN_KEY" || k == "ENGINE_TOKEN" ||
            k == "DATA_DIR" || k == "HOME" || k == "TMPDIR" || k == "NODE_ENV" ||
            k == "APP_VERSION") {
            setenv(k.c_str(), s.substr(eq + 1).c_str(), 1);
        }
    }
    unsetenv("NODE_OPTIONS");
    unsetenv("NODE_PATH");

    // node::Start 需要连续内存的 argv
    std::vector<std::string> parts = {"node", root + "/src/server.mjs"};
    int argc = (int) parts.size();
    size_t total = 0;
    for (auto &p : parts) total += p.size() + 1;
    char *block = (char *) calloc(total, sizeof(char));
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    char *cur = block;
    for (int i = 0; i < argc; i++) {
        memcpy(cur, parts[i].c_str(), parts[i].size());
        argv[i] = cur;
        cur += parts[i].size() + 1;
    }

    redirectStdio();
    return node::Start(argc, argv);
}
