cmake_minimum_required(VERSION 3.10.2)
project(wagnode)

# CMAKE_SOURCE_DIR = engine-node/src/main/cpp
# libnode 由 CI 下载到 engine-node/libnode，需要向上三层
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(native-lib SHARED native-lib.cpp)
include_directories(${LIBNODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
