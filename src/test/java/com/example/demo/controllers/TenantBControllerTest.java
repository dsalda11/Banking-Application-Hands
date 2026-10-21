package com.example.demo.controllers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Collections;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;

import org.junit.Before;
import org.junit.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.ui.ModelMap;

import com.example.demo.model.User;
import com.example.demo.service.CheckProfile;
import com.example.demo.service.LoginService;
import com.example.demo.service.Mailservice;

public class TenantBControllerTest {

	private TenantBController controller;
	private LoginService loginService;
	private CheckProfile checkProfile;
	private Mailservice mailService;

	@Before
	public void setUp() {
		controller = new TenantBController();
		loginService = mock(LoginService.class);
		checkProfile = mock(CheckProfile.class);
		mailService = mock(Mailservice.class);
		ReflectionTestUtils.setField(controller, "loginService", loginService);
		ReflectionTestUtils.setField(controller, "checkProfile", checkProfile);
		ReflectionTestUtils.setField(controller, "mailService", mailService);
	}

	@Test
	public void staffLoginUsesTenantBRouteAndSharedAuthentication() {
		HttpServletRequest request = mock(HttpServletRequest.class);
		HttpSession session = mock(HttpSession.class);
		when(loginService.getRole("staff", "password")).thenReturn("emp");
		when(request.getSession(false)).thenReturn(null);
		when(request.getSession(true)).thenReturn(session);

		String view = controller.validateLogin("staff", "password", new ModelMap(), request);

		assertEquals("redirect:/tenant-b/operations", view);
		verify(session).setAttribute("username", "staff");
		verify(session).setAttribute("role", "emp");
		verify(mailService).sendEmail("staff");
	}

	@Test
	public void nonStaffLoginFailsClosed() {
		HttpServletRequest request = mock(HttpServletRequest.class);
		when(loginService.getRole("customer", "password")).thenReturn("cust");
		ModelMap model = new ModelMap();

		assertEquals(
				"tenant-b-login",
				controller.validateLogin("customer", "password", model, request));
		assertTrue((Boolean) model.get("loginFailed"));
	}

	@Test
	public void clientLookupAndAccountDetailsReuseSharedCustomerService() {
		HttpSession session = mock(HttpSession.class);
		when(session.getAttribute("username")).thenReturn("staff");
		User customer = new User("Customer", "customer", "2023", 1L, "Local", 1L, 31444L);
		when(checkProfile.getCustomers("customer")).thenReturn(Collections.singletonList(customer));
		when(checkProfile.getDetails("customer")).thenReturn(Collections.singletonList(customer));

		ModelMap directory = new ModelMap();
		assertEquals("tenant-b-clients", controller.clients("customer", directory, session));
		assertEquals(Collections.singletonList(customer), directory.get("clients"));
		assertEquals(Boolean.FALSE, directory.get("notFound"));

		ModelMap account = new ModelMap();
		assertEquals("tenant-b-account", controller.account("customer", account, session));
		assertEquals(Collections.singletonList(customer), account.get("clients"));
	}

	@Test
	public void missingClientIsAnExplicitViewState() {
		HttpSession session = mock(HttpSession.class);
		when(checkProfile.getCustomers("missing")).thenReturn(Collections.emptyList());
		ModelMap model = new ModelMap();

		assertEquals("tenant-b-clients", controller.clients("missing", model, session));
		assertEquals(Boolean.TRUE, model.get("notFound"));
	}
}
