package com.wag2api.engine;

interface INodeEngine {
    int getPort();
    int getPid();
    boolean isReady();
    void shutdown();
}
