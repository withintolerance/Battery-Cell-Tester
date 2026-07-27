#include "tester_shared.h"

#if !ENABLE_SERIAL_OUTPUT
NullSerialSink gNullSerial;

void NullSerialSink::begin(unsigned long baud) {
  (void)baud;
}

void NullSerialSink::begin(unsigned long baud, uint32_t config) {
  (void)baud;
  (void)config;
}

void NullSerialSink::end() {}

int NullSerialSink::available() {
  return 0;
}

int NullSerialSink::read() {
  return -1;
}

void NullSerialSink::flush() {}

size_t NullSerialSink::write(uint8_t value) {
  (void)value;
  return 0;
}

size_t NullSerialSink::write(const uint8_t *buffer, size_t size) {
  (void)buffer;
  (void)size;
  return 0;
}

size_t NullSerialSink::write(const char *str) {
  (void)str;
  return 0;
}
#endif
