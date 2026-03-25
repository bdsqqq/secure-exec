/* signal_handler.c — cooperative signal handling test for WasmVM.
 *
 * Registers a SIGINT handler via signal(), then busy-loops with sleep syscalls
 * (each sleep is a syscall boundary where pending signals are delivered).
 * The test runner sends SIGINT via kernel.kill() and verifies the handler fires.
 *
 * Usage: signal_handler
 * Output:
 *   handler_registered
 *   waiting
 *   caught_signal=2
 */
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile int got_signal = 0;

static void handler(int sig) {
    got_signal = sig;
}

int main(void) {
    signal(SIGINT, handler);
    printf("handler_registered\n");
    fflush(stdout);

    printf("waiting\n");
    fflush(stdout);

    /* Busy-loop with sleep — each usleep is a syscall boundary where
     * the JS worker checks for pending signals and invokes the trampoline. */
    for (int i = 0; i < 1000 && !got_signal; i++) {
        usleep(10000);  /* 10ms */
    }

    if (got_signal) {
        printf("caught_signal=%d\n", got_signal);
    } else {
        printf("timeout_no_signal\n");
    }

    return got_signal ? 0 : 1;
}
