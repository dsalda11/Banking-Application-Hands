package com.example.demo.config;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import org.junit.Test;

public class SessionRoleInterceptorTest {

	private final SessionRoleInterceptor interceptor = new SessionRoleInterceptor();

	@Test
	public void tenantBLoginRoutesRemainPublic() throws Exception {
		HttpServletRequest request = requestFor("/tenant-b/login", null);
		assertTrue(interceptor.preHandle(request, mock(HttpServletResponse.class), new Object()));
	}

	@Test
	public void unauthenticatedTenantBRequestRedirectsToTenantBLogin() throws Exception {
		HttpServletRequest request = requestFor("/tenant-b/clients", null);
		HttpServletResponse response = mock(HttpServletResponse.class);

		assertFalse(interceptor.preHandle(request, response, new Object()));
		verify(response).sendRedirect("/tenant-b/login");
	}

	@Test
	public void nonStaffCannotAccessTenantBClientData() throws Exception {
		HttpSession session = mock(HttpSession.class);
		when(session.getAttribute("username")).thenReturn("customer");
		when(session.getAttribute("role")).thenReturn("cust");
		HttpServletRequest request = requestFor("/tenant-b/client/account", session);
		HttpServletResponse response = mock(HttpServletResponse.class);

		assertFalse(interceptor.preHandle(request, response, new Object()));
		verify(response).sendError(HttpServletResponse.SC_FORBIDDEN, "Staff access required");
	}

	private HttpServletRequest requestFor(String path, HttpSession session) {
		HttpServletRequest request = mock(HttpServletRequest.class);
		when(request.getServletPath()).thenReturn(path);
		when(request.getContextPath()).thenReturn("");
		when(request.getSession(false)).thenReturn(session);
		return request;
	}
}
